/**
 * Import orchestrator — reads Siltflow .db, generates Markdown notes.
 *
 * Handles the full pipeline:
 *   1. Open SQLite database
 *   2. Query all tables
 *   3. Group by document
 *   4. Incremental diff against existing import index + .md files
 *   5. Write one Markdown note per document (frontmatter + title + summary
 *      callout + one card-style callout per annotation)
 *   6. Update import index
 */
import type { App, Vault } from "obsidian";
import { TFile } from "obsidian";
import {
  openDatabase,
  queryAll,
  closeDatabase,
} from "./db";
import {
  buildMarkdownNote,
  buildCardBlocks,
  v2Granularity,
  type FormatterOptions,
} from "./formatter";
import type {
  DocumentRow,
  AnnotationRow,
  AIResultRow,
  SummaryRow,
  FSRSCardRow,
  ParsedAIResult,
  ParsedFSRSCard,
  DocumentRenderData,
  ImportIndex,
} from "./types";
import type { SiltflowImporterSettings } from "./settings";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Run the full import pipeline.
 *
 * @param app Obsidian App instance
 * @param dbPath Path to the Siltflow data.db file
 * @param settings Plugin settings
 * @param selectedDocIds Specific doc IDs to import (from modal), or empty for all
 */
export async function importDatabase(
  app: App,
  dbPath: string,
  settings: SiltflowImporterSettings,
  selectedDocIds: string[],
): Promise<ImportResult> {
  const db = await openDatabase(dbPath);
  const vault = app.vault;

  try {
    // 1. Query all tables
    const documents = queryAll<DocumentRow>(db, "SELECT * FROM documents");
    const annotations = queryAll<AnnotationRow>(
      db,
      "SELECT * FROM annotations",
    );
    const aiResults = queryAll<AIResultRow>(db, "SELECT * FROM ai_results");
    const summaries = queryAll<SummaryRow>(db, "SELECT * FROM summaries");
    const fsrsCards = queryAll<FSRSCardRow>(db, "SELECT * FROM fsrs_cards");

    // 2. Build lookup maps
    const aiResultMap = new Map<string, Map<string, ParsedAIResult>>();
    const aiVersionMap = new Map<string, Map<string, number>>();
    for (const r of aiResults) {
      const docMap =
        aiResultMap.get(r.document_id) ||
        aiResultMap.set(r.document_id, new Map()).get(r.document_id)!;
      const verMap =
        aiVersionMap.get(r.document_id) ||
        aiVersionMap.set(r.document_id, new Map()).get(r.document_id)!;
      try {
        docMap.set(r.annotation_id, JSON.parse(r.data) as ParsedAIResult);
        verMap.set(r.annotation_id, r.version);
      } catch {
        // skip unparseable AI results
      }
    }

    const summaryMap = new Map<string, SummaryRow>();
    for (const s of summaries) {
      summaryMap.set(s.document_id, s);
    }

    const cardsMap = new Map<string, FSRSCardRow[]>();
    for (const c of fsrsCards) {
      const arr = cardsMap.get(c.document_id) || [];
      arr.push(c);
      cardsMap.set(c.document_id, arr);
    }

    // 3. Group annotations by document (must precede doc filtering)
    const annotationsByDoc = new Map<string, AnnotationRow[]>();
    for (const ann of annotations) {
      const arr = annotationsByDoc.get(ann.document_id) || [];
      arr.push(ann);
      annotationsByDoc.set(ann.document_id, arr);
    }

    // 4. Filter documents
    let docsToImport = documents;
    if (selectedDocIds.length > 0) {
      const idSet = new Set(selectedDocIds);
      docsToImport = documents.filter((d) => idSet.has(d.id));
    }
    if (!settings.includeDocumentsWithoutAnnotations) {
      docsToImport = docsToImport.filter((d) => {
        const docAnnotations = annotationsByDoc.get(d.id) || [];
        const docCards = cardsMap.get(d.id) || [];
        return docAnnotations.length > 0 || docCards.length > 0;
      });
    }

    // 5. Load import index
    const index = await loadImportIndex(vault, settings.outputFolder);

    // Precompute safe doc filenames; dedup collisions with a docId suffix.
    const safeDocMap = computeSafeDocSlugs(docsToImport);

    // 6. Process each document
    const result: ImportResult = { created: 0, updated: 0, skipped: 0 };

    for (const doc of docsToImport) {
      const safeDoc = safeDocMap.get(doc.id) || sanitizeFilename(doc.title);
      const notePath = `${settings.outputFolder}/${safeDoc}.md`;

      const docAnnotations = (annotationsByDoc.get(doc.id) || [])
        .sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        )
        .filter((a) =>
          includeAnnotationByType(
            a,
            aiResultMap.get(doc.id)?.get(a.id),
            settings.includeTypes,
          ),
        );

      const aiVersions = aiVersionMap.get(doc.id) || new Map<string, number>();
      const data: DocumentRenderData = {
        doc,
        annotations: docAnnotations,
        aiResults: new Map(
          docAnnotations.map((a) => [
            a.id,
            aiResultMap.get(doc.id)?.get(a.id),
          ]),
        ),
        aiVersions: new Map(
          docAnnotations.map((a) => [a.id, aiVersions.get(a.id) ?? 0]),
        ),
        cards: new Map(
          docAnnotations.map((a) => [a.id, parseCard(cardsMap.get(doc.id)?.find((c) => c.annotation_id === a.id))]),
        ),
        aiVersion: getMaxAIVersion(aiVersions),
        summary: summaryMap.get(doc.id) || null,
        notePath,
        includeFSRSStats: settings.includeFSRSStats,
      };

      await ensureFolderExists(vault, settings.outputFolder);

      const options: FormatterOptions = {
        includeAIResults: settings.includeAIResults,
        includeFSRSStats: settings.includeFSRSStats,
        calloutFold: settings.calloutFold,
      };

      const existingEntry = index.documents[doc.id];
      const existingFile = existingEntry
        ? vault.getAbstractFileByPath(existingEntry.file)
        : null;

      // ── Decide write strategy per incremental mode ──
      const fullRender =
        settings.incrementalMode === "overwrite" ||
        !existingEntry ||
        !existingFile ||
        (settings.incrementalMode === "update" &&
          hasChangedAI(existingEntry, aiVersions));

      if (fullRender) {
        const content = buildMarkdownNote(data, options);
        if (existingFile) {
          await vault.modify(existingFile as import("obsidian").TFile, content);
          result.updated++;
        } else {
          await vault.create(notePath, content);
          result.created++;
        }
      } else {
        // Incremental append: add only annotations missing from the note.
        const existingContent = await vault.read(
          existingFile as import("obsidian").TFile,
        );
        const existingAnnIds = extractAnnotationIds(existingContent);
        const newAnnotations = data.annotations.filter(
          (a) => !existingAnnIds.has(a.id),
        );

        if (newAnnotations.length > 0) {
          const appendix = buildCardBlocks(newAnnotations, data, options);
          const updatedContent = existingContent.trimEnd() + "\n\n" + appendix + "\n";
          await vault.modify(
            existingFile as import("obsidian").TFile,
            updatedContent,
          );
          result.updated++;
        } else {
          result.skipped++;
        }
      }

      // Update index entry
      const annotationsIndex: ImportIndex["documents"][string]["annotations"] = {};
      for (const ann of docAnnotations) {
        annotationsIndex[ann.id] = {
          aiVersion: aiVersions.get(ann.id) ?? 0,
          cardDue: data.cards.get(ann.id)?.due ?? null,
        };
      }
      index.documents[doc.id] = {
        file: notePath,
        annotations: annotationsIndex,
        lastSync: new Date().toISOString(),
      };
    }

    // 7. Save import index
    index.lastImport = new Date().toISOString();
    index.dbPath = dbPath;
    await saveImportIndex(vault, settings.outputFolder, index);

    return result;
  } finally {
    closeDatabase(db);
  }
}

/** True when any of the doc's annotations has a newer AI version than last written. */
function hasChangedAI(
  existingEntry: ImportIndex["documents"][string],
  aiVersions: Map<string, number>,
): boolean {
  for (const [annId, version] of aiVersions) {
    const prev = existingEntry.annotations?.[annId]?.aiVersion ?? 0;
    if (version !== prev) return true;
  }
  return false;
}

/**
 * Assign a unique safe doc slug per document. Duplicate titles (after
 * sanitization) get a short docId suffix so per-doc notes never collide.
 */
function computeSafeDocSlugs(docs: DocumentRow[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Map<string, number>();
  for (const doc of docs) {
    const base = sanitizeFilename(doc.title);
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    const slug = count > 0 ? `${base}-${doc.id.slice(0, 8)}` : base;
    map.set(doc.id, slug);
  }
  return map;
}

/** Parse an FSRS card row into the fields we expose. */
function parseCard(card: FSRSCardRow | undefined): ParsedFSRSCard | undefined {
  if (!card) return undefined;
  try {
    const raw = JSON.parse(card.data);
    return {
      state: raw.state ?? 0,
      due: raw.due ?? null,
      reps: raw.reps ?? 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether an annotation should be imported given the per-type toggles.
 * Only V2-typed annotations (with an explicit `ai.input.type`) are gated;
 * annotations without a V2 type (no AI result, or V1 data) are always kept.
 */
function includeAnnotationByType(
  ann: AnnotationRow,
  ai: ParsedAIResult | undefined,
  includeTypes: { word: boolean; phrase: boolean; sentence: boolean },
): boolean {
  const type = v2Granularity(ai);
  if (!type) return true;
  return includeTypes[type];
}

/** Extract the set of siltflow-annotation IDs embedded in a note's callouts. */
function extractAnnotationIds(content: string): Set<string> {
  const ids = new Set<string>();
  const re = /siltflow-annotation:\s*([0-9a-f-]{36}|[^\s,]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Import index helpers
// ---------------------------------------------------------------------------

const INDEX_FILENAME = "_siltflow_import.json";
const META_FOLDER = "_meta";
const INDEX_FORMAT_VERSION = 4;

function freshIndex(): ImportIndex {
  return {
    formatVersion: INDEX_FORMAT_VERSION,
    lastImport: "",
    dbPath: "",
    documents: {},
  };
}

async function loadImportIndex(
  vault: Vault,
  outputFolder: string,
): Promise<ImportIndex> {
  const indexPath = `${outputFolder}/${META_FOLDER}/${INDEX_FILENAME}`;
  const file = vault.getAbstractFileByPath(indexPath);
  if (!file) {
    return freshIndex();
  }
  try {
    const content = await vault.read(file as import("obsidian").TFile);
    const parsed = JSON.parse(content) as ImportIndex;
    if (parsed.formatVersion !== INDEX_FORMAT_VERSION) {
      // Old schema (single-file-per-doc or earlier) — start fresh.
      return freshIndex();
    }
    return parsed;
  } catch {
    return freshIndex();
  }
}

async function saveImportIndex(
  vault: Vault,
  outputFolder: string,
  index: ImportIndex,
): Promise<void> {
  const indexPath = `${outputFolder}/${META_FOLDER}/${INDEX_FILENAME}`;
  const content = JSON.stringify(index, null, 2);
  const file = vault.getAbstractFileByPath(indexPath);
  if (file) {
    await vault.modify(file as import("obsidian").TFile, content);
  } else {
    await ensureFolderExists(vault, `${outputFolder}/${META_FOLDER}`);
    await vault.create(indexPath, content);
  }
}

// ---------------------------------------------------------------------------
// Fold-state sync
// ---------------------------------------------------------------------------

/**
 * Rewrite every imported note's annotation callout fold markers to match the
 * current `calloutFold` setting. Operates on the notes tracked by the import
 * index, so it only touches notes this plugin generated.
 *
 * Returns the number of notes rewritten.
 */
export async function syncCalloutFolds(
  vault: Vault,
  outputFolder: string,
  calloutFold: "expanded" | "collapsed" | "none",
): Promise<number> {
  const index = await loadImportIndex(vault, outputFolder);
  const target = FOLD_MARKER[calloutFold];
  let rewritten = 0;

  for (const entry of Object.values(index.documents)) {
    const file = vault.getAbstractFileByPath(entry.file);
    if (!(file instanceof TFile)) continue;

    const content = await vault.read(file as import("obsidian").TFile);
    // Replace the fold marker on every annotation card line:
    // `> [!siltflow]+ word`, `> [!siltflow]- word`, or `> [!siltflow] word`.
    // Anchored to the callout prefix so other `[!siltflow]` text is untouched.
    const updated = content.replace(
      /(^> \[!siltflow\])[-+]?\s/gm,
      (match, prefix: string) => `${prefix}${target} `,
    );
    if (updated !== content) {
      await vault.modify(file as import("obsidian").TFile, updated);
      rewritten++;
    }
  }
  return rewritten;
}

/** Map calloutFold setting → the fold marker on `> [!siltflow]`. */
const FOLD_MARKER: Record<"expanded" | "collapsed" | "none", string> = {
  expanded: "+",
  collapsed: "-",
  none: "",
};

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

async function ensureFolderExists(
  vault: Vault,
  folderPath: string,
): Promise<void> {
  if (!folderPath || folderPath === ".") return;

  const parts = folderPath.split("/");
  let current = "";
  for (const part of parts) {
    if (!part) continue;
    const next = current ? `${current}/${part}` : part;
    const existing = vault.getAbstractFileByPath(next);
    if (!existing) {
      await vault.createFolder(next);
    }
    current = next;
  }
}

function sanitizeFilename(name: string): string {
  // Replace characters invalid in filenames; strip control chars and quotes
  // so folder names and file.inFolder(...) arguments stay YAML-safe.
  return name
    .replace(/['"`]/g, "")
    .replace(/[/\\?%*:|<>]/g, "-")
    .replace(/\s+/g, " ") // collapse whitespace (incl. newlines) before stripping
    .replace(/[\x00-\x1f\x7f]/g, "") // strip remaining control chars
    .trim()
    .slice(0, 200); // Reasonable max length
}

function getMaxAIVersion(
  versionMap: Map<string, number> | undefined,
): number {
  if (!versionMap || versionMap.size === 0) return 0;
  let max = 0;
  for (const v of versionMap.values()) {
    if (v > max) max = v;
  }
  return max;
}
