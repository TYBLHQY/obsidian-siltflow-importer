/**
 * Import orchestrator — reads Siltflow .db, generates Markdown notes.
 *
 * Handles the full pipeline:
 *   1. Open SQLite database
 *   2. Query all tables
 *   3. Group by document
 *   4. Incremental diff against existing import index + .md files
 *   5. Write/update .md files via Obsidian Vault API
 *   6. Update import index and .base dashboard
 */
import type { App, Vault } from "obsidian";
import {
  openDatabase,
  queryAll,
  closeDatabase,
} from "./db";
import { buildMarkdownNote, buildAIDetailBlocks, detectTargetLang } from "./formatter";
import { generateBaseFileContent, updateBaseFileContent } from "./base-generator";
import type {
  DocumentRow,
  AnnotationRow,
  AIResultRow,
  SummaryRow,
  FSRSCardRow,
  FolderRow,
  ParsedAIResult,
  DocumentImportData,
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
    const folders = queryAll<FolderRow>(db, "SELECT * FROM folders");

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

    // Build folder path map
    const folderMap = buildFolderPathMap(folders);
    const docFolderMap = new Map<string, string>();
    for (const doc of documents) {
      if (doc.folder_id) {
        docFolderMap.set(doc.id, folderMap.get(doc.folder_id) || "");
      } else {
        docFolderMap.set(doc.id, "");
      }
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

    // 6. Process each document
    const result: ImportResult = { created: 0, updated: 0, skipped: 0 };

    for (const doc of docsToImport) {
      const data: DocumentImportData = {
        doc,
        annotations: (annotationsByDoc.get(doc.id) || []).sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        ),
        aiResults: aiResultMap.get(doc.id) || new Map(),
        aiVersion: getMaxAIVersion(aiVersionMap.get(doc.id)),
        summary: summaryMap.get(doc.id) || null,
        fsrsCards: cardsMap.get(doc.id) || [],
        folderPath: settings.preserveFolderStructure
          ? docFolderMap.get(doc.id) || ""
          : "",
      };

      const existingEntry = index?.documents?.[doc.id];

      if (settings.incrementalMode === "overwrite" || !existingEntry) {
        // Full create (new doc or overwrite mode)
        const filePath = buildFilePath(data, settings);
        await ensureFolderExists(vault, getFolderFromPath(filePath));
        const content = buildMarkdownNote(data, {
          includeAIResults: settings.includeAIResults,
          includeFSRSStats: settings.includeFSRSStats,
          calloutFold: settings.calloutFold,
        });

        const existingFile = vault.getAbstractFileByPath(filePath);
        if (existingFile) {
          await vault.modify(existingFile as import("obsidian").TFile, content);
          result.updated++;
        } else {
          await vault.create(filePath, content);
          result.created++;
        }

        // Update index
        index.documents[doc.id] = {
          file: filePath,
          annotations: data.annotations.length,
          lastSync: new Date().toISOString(),
        };
      } else {
        // Incremental: append new annotations
        const existingFilePath = existingEntry.file;
        const existingFile = vault.getAbstractFileByPath(existingFilePath);
        if (!existingFile) {
          // File was deleted — recreate
          const filePath = buildFilePath(data, settings);
          const content = buildMarkdownNote(data, {
            includeAIResults: settings.includeAIResults,
            includeFSRSStats: settings.includeFSRSStats,
            calloutFold: settings.calloutFold,
          });
          await vault.create(filePath, content);
          result.created++;
          index.documents[doc.id].file = filePath;
        } else {
          const existingContent = await vault.read(
            existingFile as import("obsidian").TFile,
          );
          const existingAnnIds = extractAnnotationIds(existingContent);
          const newAnnotations = data.annotations.filter(
            (a) => !existingAnnIds.has(a.id),
          );

          if (newAnnotations.length > 0) {
            const appendix = buildAnnotationAppendix(
              newAnnotations,
              data.aiResults,
              data.aiVersion,
              settings,
            );
            const updatedContent = existingContent + "\n" + appendix;
            await vault.modify(
              existingFile as import("obsidian").TFile,
              updatedContent,
            );
            result.updated++;
          } else {
            result.skipped++;
          }

          // Update index entry
          index.documents[doc.id].annotations = data.annotations.length;
          index.documents[doc.id].lastSync = new Date().toISOString();
        }
      }
    }

    // 7. Save import index
    index.lastImport = new Date().toISOString();
    index.dbPath = dbPath;
    await saveImportIndex(vault, settings.outputFolder, index);

    // 8. Update .base dashboard
    if (settings.createBaseFile) {
      await updateBaseDashboard(vault, settings.outputFolder);
    }

    return result;
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Folder path builder
// ---------------------------------------------------------------------------

function buildFolderPathMap(folders: FolderRow[]): Map<string, string> {
  const map = new Map<string, string>();
  const parentMap = new Map<string, string | null>();
  const nameMap = new Map<string, string>();

  for (const f of folders) {
    parentMap.set(f.id, f.parent_id);
    nameMap.set(f.id, f.name);
  }

  function getPath(id: string): string {
    if (map.has(id)) return map.get(id)!;
    const parentId = parentMap.get(id);
    if (!parentId) {
      const name = nameMap.get(id) || "";
      map.set(id, name ? `${name}/` : "");
      return map.get(id)!;
    }
    const parentPath = getPath(parentId);
    const name = nameMap.get(id) || "";
    const path = parentPath ? `${parentPath}${name}/` : `${name}/`;
    map.set(id, path);
    return path;
  }

  for (const f of folders) {
    getPath(f.id);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Import index helpers
// ---------------------------------------------------------------------------

const INDEX_FILENAME = "_siltflow_import.json";

async function loadImportIndex(
  vault: Vault,
  outputFolder: string,
): Promise<ImportIndex> {
  const indexPath = `${outputFolder}/${INDEX_FILENAME}`;
  const file = vault.getAbstractFileByPath(indexPath);
  if (!file) {
    return {
      lastImport: "",
      dbPath: "",
      documents: {},
    };
  }
  try {
    const content = await vault.read(file as import("obsidian").TFile);
    return JSON.parse(content) as ImportIndex;
  } catch {
    return { lastImport: "", dbPath: "", documents: {} };
  }
}

async function saveImportIndex(
  vault: Vault,
  outputFolder: string,
  index: ImportIndex,
): Promise<void> {
  const indexPath = `${outputFolder}/${INDEX_FILENAME}`;
  const content = JSON.stringify(index, null, 2);
  const file = vault.getAbstractFileByPath(indexPath);
  if (file) {
    await vault.modify(file as import("obsidian").TFile, content);
  } else {
    await ensureFolderExists(vault, outputFolder);
    await vault.create(indexPath, content);
  }
}

// ---------------------------------------------------------------------------
// Annotation ID extraction (for incremental import)
// ---------------------------------------------------------------------------

/**
 * Parse existing .md content to find all imported annotation IDs.
 *
 * Annotation IDs are stored in HTML comments:
 * `<!-- siltflow-annotation: ann-1, ai-version: 1 -->`
 */
function extractAnnotationIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  const regex = /<!--\s*siltflow-annotation:\s*([^\s,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Incremental appendix builder
// ---------------------------------------------------------------------------

function buildAnnotationAppendix(
  annotations: AnnotationRow[],
  aiResults: Map<string, ParsedAIResult>,
  aiVersion: number,
  settings: SiltflowImporterSettings,
): string {
  const parts: string[] = [""];
  for (const ann of annotations) {
    const ai = aiResults.get(ann.id);
    const fold =
      settings.calloutFold === "none"
        ? ""
        : settings.calloutFold === "collapsed"
          ? "+"
          : "-";
    const titleText = ann.text
      ? ann.text.replace(/\n/g, " ").slice(0, 60)
      : ann.type;

    parts.push(`> [!${ann.type}]${fold} ${titleText}`);

    const metaParts: string[] = [`siltflow-annotation: ${ann.id}`];
    if (aiVersion > 0) {
      metaParts.push(`ai-version: ${aiVersion}`);
    }
    parts.push(`> <!-- ${metaParts.join(", ")} -->`);

    // ── AI header: source/target language ──
    const langParts: string[] = [];
    if (ai?.input?.source_lang) langParts.push(`Source: \`${ai.input.source_lang}\``);
    const targetLang = ai?.target_lang || (ai ? detectTargetLang(ai) : null);
    if (targetLang) langParts.push(`Target: \`${targetLang}\``);

    if (ann.page_number) {
      parts.push(`> **Page**: ${ann.page_number}`);
    }

    if (ann.text) {
      parts.push("> **Original**: " + ann.text.replace(/\n/g, "\n> "));
    }

    if (settings.includeAIResults && ai) {
      if (langParts.length > 0) {
        parts.push(">");
        parts.push("> " + langParts.join(" | "));
      }

      const { core, details } = buildAIDetailBlocks(ai, ann.text ?? "");
      // Core content (translation, meta tags, definitions/meanings)
      for (const line of core) {
        if (line === "") {
          parts.push(">");
        } else {
          parts.push("> " + line.replace(/\n/g, "\n> "));
        }
      }
      // Details (examples, collocations, alternatives, synonyms)
      if (details.length > 0) {
        parts.push(">");
        for (const line of details) {
          if (line === "") {
            parts.push(">");
          } else {
            parts.push("> " + line.replace(/\n/g, "\n> "));
          }
        }
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Base dashboard update
// ---------------------------------------------------------------------------

const BASE_FILENAME = "_Siltflow.base";

async function updateBaseDashboard(
  vault: Vault,
  outputFolder: string,
): Promise<void> {
  const basePath = `${outputFolder}/${BASE_FILENAME}`;
  const existingFile = vault.getAbstractFileByPath(basePath);

  // Known frontmatter properties that might be present
  const knownProps = [
    "siltflow_source",
    "siltflow_ai_version",
    "total_cards",
    "new_cards",
    "due_cards",
    "pages",
  ];

  if (existingFile) {
    const existingYaml = await vault.read(
      existingFile as import("obsidian").TFile,
    );
    const updated = updateBaseFileContent(existingYaml, knownProps);
    await vault.modify(existingFile as import("obsidian").TFile, updated);
  } else {
    await ensureFolderExists(vault, outputFolder);
    const content = generateBaseFileContent();
    await vault.create(basePath, content);
  }
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

function buildFilePath(
  data: DocumentImportData,
  settings: SiltflowImporterSettings,
): string {
  const safeName = sanitizeFilename(data.doc.title);
  const folder = settings.outputFolder;
  const subFolder = data.folderPath ? `${folder}/${data.folderPath}` : folder;
  // Remove trailing slash
  const cleanSubFolder = subFolder.replace(/\/$/, "");
  return `${cleanSubFolder}/${safeName}.md`;
}

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
  // Replace characters invalid in filenames
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
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
