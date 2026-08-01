/**
 * Import orchestrator — reads Siltflow .db, generates Markdown notes.
 *
 * Handles the full pipeline:
 *   1. Open SQLite database
 *   2. Query all tables
 *   3. Group by document
 *   4. Sync diff against the import index + per-doc annotation index
 *   5. Write one Markdown note per document (frontmatter + title + summary
 *      callout + one card-style callout per annotation)
 *   6. Update import index + annotation index
 *
 * Sync rules (update mode): a document's note is re-rendered when any of its
 * annotations is new, has a newer `updated_at` than the last import, or was
 * deleted from the DB — a full re-render covers add/change/delete at once.
 * The summary is re-rendered when its `updated_at` changed. Unchanged
 * documents are skipped entirely.
 *
 * Annotation sync state lives in one `.jsonl` per document under `_meta/anns/`
 * (one line per annotation: `{ "id", "importedAt" }`), so no index file ever
 * grows with the total word count.
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
  v2Granularity,
  type FormatterOptions,
} from "./formatter";
import type {
  DocumentRow,
  AnnotationRow,
  AIResultRow,
  SummaryRow,
  ParsedAIResult,
  DocumentRenderData,
  ImportIndex,
  DocumentIndexLine,
  AnnotationIndexLine,
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

    // 2. Build lookup maps
    const aiResultMap = new Map<string, Map<string, ParsedAIResult>>();
    const aiVersionMap = new Map<string, Map<string, number>>();
    const aiUpdatedAtMap = new Map<string, Map<string, string>>();
    for (const r of aiResults) {
      const docMap =
        aiResultMap.get(r.document_id) ||
        aiResultMap.set(r.document_id, new Map()).get(r.document_id)!;
      const verMap =
        aiVersionMap.get(r.document_id) ||
        aiVersionMap.set(r.document_id, new Map()).get(r.document_id)!;
      const updMap =
        aiUpdatedAtMap.get(r.document_id) ||
        aiUpdatedAtMap.set(r.document_id, new Map()).get(r.document_id)!;
      try {
        docMap.set(r.annotation_id, JSON.parse(r.data) as ParsedAIResult);
        verMap.set(r.annotation_id, r.version);
        updMap.set(r.annotation_id, r.updated_at);
      } catch {
        // skip unparseable AI results
      }
    }

    const summaryMap = new Map<string, SummaryRow>();
    for (const s of summaries) {
      summaryMap.set(s.document_id, s);
    }

    // 3. Group annotations by document (must precede doc filtering)
    const annotationsByDoc = new Map<string, AnnotationRow[]>();
    for (const ann of annotations) {
      const arr = annotationsByDoc.get(ann.document_id) || [];
      arr.push(ann);
      annotationsByDoc.set(ann.document_id, arr);
    }

    // 4. Filter documents — only import docs that have at least one annotation
    let docsToImport = documents;
    if (selectedDocIds.length > 0) {
      const idSet = new Set(selectedDocIds);
      docsToImport = documents.filter((d) => idSet.has(d.id));
    }
    docsToImport = docsToImport.filter((d) => {
      const docAnnotations = annotationsByDoc.get(d.id) || [];
      return docAnnotations.length > 0;
    });

    // 5. Load import index + documents index
    const index = await loadImportIndex(vault, settings.outputFolder);
    const documentsIndex = await loadDocumentsIndex(vault, settings.outputFolder);

    // Precompute safe doc filenames; dedup collisions with a docId suffix.
    const safeDocMap = computeSafeDocSlugs(docsToImport);

    // 6. Process each document
    const result: ImportResult = { created: 0, updated: 0, skipped: 0 };
    const annsDir = `${settings.outputFolder}/${META_FOLDER}/anns`;

    for (const doc of docsToImport) {
      const safeDoc = safeDocMap.get(doc.id) || sanitizeFilename(doc.title);
      const notePath = `${settings.outputFolder}/${safeDoc}.md`;
      const annsFilePath = `${annsDir}/${safeDoc}.jsonl`;

      const docAnnotations = (annotationsByDoc.get(doc.id) || [])
        .sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        )
        .filter((a) =>
          includeAnnotation(
            a,
            aiResultMap.get(doc.id)?.get(a.id),
            settings.includeTypes,
          ),
        );

      const aiVersions = aiVersionMap.get(doc.id) || new Map<string, number>();
      const aiUpdatedAt = aiUpdatedAtMap.get(doc.id) || new Map<string, string>();
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
        aiVersion: getMaxAIVersion(aiVersions),
        summary: summaryMap.get(doc.id) || null,
        notePath,
      };

      await ensureFolderExists(vault, settings.outputFolder);
      await ensureFolderExists(vault, annsDir);

      const options: FormatterOptions = {
        calloutFold: settings.calloutFold,
      };

      let existingEntry: DocumentIndexLine | undefined =
        documentsIndex.get(doc.id);
      let existingFile = existingEntry
        ? vault.getAbstractFileByPath(existingEntry.file)
        : null;

      // Handle doc rename / note-path change: drop the stale note + anns index.
      if (existingEntry && existingEntry.file !== notePath) {
        if (existingFile) {
          await vault.delete(existingFile as TFile);
          existingFile = null;
        }
        const oldAnns = vault.getAbstractFileByPath(existingEntry.annsFile);
        if (oldAnns) await vault.delete(oldAnns as TFile);
        existingEntry = undefined;
      }

      let written = false;

      if (settings.incrementalMode === "overwrite") {
        // Full re-render. Clean up stale files, then write fresh.
        if (existingEntry && existingFile && existingEntry.file === notePath) {
          const oldAnns = vault.getAbstractFileByPath(existingEntry.annsFile);
          if (oldAnns && oldAnns.path !== annsFilePath) await vault.delete(oldAnns as TFile);
        }
        const content = buildMarkdownNote(data, options);
        if (existingFile) {
          await vault.modify(existingFile as TFile, content);
          result.updated++;
        } else {
          await vault.create(notePath, content);
          result.created++;
        }
        written = true;
      } else if (!existingEntry || !existingFile) {
        // New document — create the note.
        const content = buildMarkdownNote(data, options);
        await vault.create(notePath, content);
        result.created++;
        written = true;
      } else {
        // Sync mode — re-render only when something changed.
        const prevAnns = await loadAnnsIndex(vault, existingEntry.annsFile);
        const needsRender =
          summaryChanged(data.summary, existingEntry.summaryImportedAt) ||
          hasAnnotationChanges(docAnnotations, prevAnns, aiUpdatedAt);

        if (needsRender) {
          const content = buildMarkdownNote(data, options);
          await vault.modify(existingFile as TFile, content);
          result.updated++;
          written = true;
        } else {
          result.skipped++;
        }
      }

      if (written) {
        await saveAnnsIndex(
          vault,
          annsFilePath,
          docAnnotations,
          aiUpdatedAt,
        );
        documentsIndex.set(doc.id, {
          id: doc.id,
          file: notePath,
          annsFile: annsFilePath,
          summaryImportedAt: data.summary?.updated_at ?? "",
          lastSync: new Date().toISOString(),
        });
      }
    }

    // 7. Save import index + documents index
    index.lastImport = new Date().toISOString();
    index.dbPath = dbPath;
    await saveImportIndex(vault, settings.outputFolder, index);
    await saveDocumentsIndex(vault, settings.outputFolder, documentsIndex);

    return result;
  } finally {
    closeDatabase(db);
  }
}

/**
 * The effective "last changed" timestamp of an annotation for sync purposes —
 * the later of the annotation row and its ai_result, so AI updates also
 * trigger a re-render. Returns the later ISO string, or whichever is present.
 */
function annotationChangedAt(
  ann: AnnotationRow,
  aiUpdatedAt: Map<string, string>,
): string {
  const annT = ann.updated_at || "";
  const aiT = aiUpdatedAt.get(ann.id) || "";
  if (!annT) return aiT;
  if (!aiT) return annT;
  return annT > aiT ? annT : aiT;
}

/** True when the summary row's updated_at differs from the last written one. */
function summaryChanged(
  summary: SummaryRow | null,
  prevImportedAt: string,
): boolean {
  const cur = summary?.updated_at ?? "";
  return cur !== prevImportedAt;
}

/** True when any annotation is new, changed, or deleted vs the previous index. */
function hasAnnotationChanges(
  current: AnnotationRow[],
  prevAnns: Map<string, string>,
  aiUpdatedAt: Map<string, string>,
): boolean {
  const currentIds = new Set(current.map((a) => a.id));
  // Deleted in the DB?
  for (const id of prevAnns.keys()) {
    if (!currentIds.has(id)) return true;
  }
  for (const ann of current) {
    const prev = prevAnns.get(ann.id);
    // New annotation?
    if (!prev) return true;
    // Changed since last import?
    const changedAt = annotationChangedAt(ann, aiUpdatedAt);
    if (changedAt && changedAt > prev) return true;
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

/**
 * Whether an annotation should be imported.
 * - `highlight`-kind annotations are raw PDF marks with no AI data — dropped.
 * - V2-typed annotations (explicit `ai.input.type`) are gated by the
 *   per-type toggles; annotations without a V2 type (no AI result, or V1
 *   data) are always kept.
 */
function includeAnnotation(
  ann: AnnotationRow,
  ai: ParsedAIResult | undefined,
  includeTypes: { word: boolean; phrase: boolean; sentence: boolean },
): boolean {
  // Pure PDF highlights carry no translation/AI — filter them out.
  if (ann.kind === "highlight") return false;
  const type = v2Granularity(ai);
  if (!type) return true;
  return includeTypes[type];
}

// ---------------------------------------------------------------------------
// Import index helpers
// ---------------------------------------------------------------------------

const INDEX_FILENAME = "_siltflow_import.json";
const DOCUMENTS_FILENAME = "documents.jsonl";
const META_FOLDER = "_meta";
const INDEX_FORMAT_VERSION = 6;

function freshIndex(): ImportIndex {
  return {
    formatVersion: INDEX_FORMAT_VERSION,
    lastImport: "",
    dbPath: "",
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
      // Old schema (documents nested in the main index) — start fresh.
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
// Documents index (.jsonl)
// ---------------------------------------------------------------------------

const DOCUMENTS_PATH = (outputFolder: string) =>
  `${outputFolder}/${META_FOLDER}/${DOCUMENTS_FILENAME}`;

/** Read the documents index into a map of document ID → DocumentIndexLine. */
async function loadDocumentsIndex(
  vault: Vault,
  outputFolder: string,
): Promise<Map<string, DocumentIndexLine>> {
  const file = vault.getAbstractFileByPath(DOCUMENTS_PATH(outputFolder));
  if (!(file instanceof TFile)) return new Map();
  const content = await vault.read(file);
  const map = new Map<string, DocumentIndexLine>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as DocumentIndexLine;
      map.set(obj.id, obj);
    } catch {
      // skip malformed lines
    }
  }
  return map;
}

/** Rewrite the documents index: one JSON line per document. */
async function saveDocumentsIndex(
  vault: Vault,
  outputFolder: string,
  documents: Map<string, DocumentIndexLine>,
): Promise<void> {
  const lines: string[] = [...documents.values()].map((d) =>
    JSON.stringify(d),
  );
  const content = lines.length > 0 ? lines.join("\n") + "\n" : "";
  const file = vault.getAbstractFileByPath(DOCUMENTS_PATH(outputFolder));
  if (file) {
    await vault.modify(file as TFile, content);
  } else {
    await ensureFolderExists(vault, getFolderFromPath(DOCUMENTS_PATH(outputFolder)));
    await vault.create(DOCUMENTS_PATH(outputFolder), content);
  }
}

// ---------------------------------------------------------------------------
// Per-document annotation index (.jsonl)
// ---------------------------------------------------------------------------

/** Read a doc's annotation index into a map of annotation ID → importedAt. */
async function loadAnnsIndex(
  vault: Vault,
  annsFilePath: string,
): Promise<Map<string, string>> {
  const file = vault.getAbstractFileByPath(annsFilePath);
  if (!(file instanceof TFile)) return new Map();
  const content = await vault.read(file);
  const map = new Map<string, string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as AnnotationIndexLine;
      map.set(obj.id, obj.importedAt);
    } catch {
      // skip malformed lines
    }
  }
  return map;
}

/** Rewrite a doc's annotation index: one JSON line per annotation. */
async function saveAnnsIndex(
  vault: Vault,
  annsFilePath: string,
  annotations: AnnotationRow[],
  aiUpdatedAt: Map<string, string>,
): Promise<void> {
  const lines: string[] = annotations.map((ann) =>
    JSON.stringify({
      id: ann.id,
      importedAt: annotationChangedAt(ann, aiUpdatedAt),
    }),
  );
  const content = lines.length > 0 ? lines.join("\n") + "\n" : "";
  const file = vault.getAbstractFileByPath(annsFilePath);
  if (file) {
    await vault.modify(file as TFile, content);
  } else {
    await ensureFolderExists(vault, getFolderFromPath(annsFilePath));
    await vault.create(annsFilePath, content);
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
  const documents = await loadDocumentsIndex(vault, outputFolder);
  const target = FOLD_MARKER[calloutFold];
  let rewritten = 0;

  for (const entry of documents.values()) {
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

function getFolderFromPath(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop(); // remove filename
  return parts.join("/");
}

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
