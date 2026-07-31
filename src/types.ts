/**
 * Siltflow SQLite database row types.
 *
 * These match the Drizzle schema in electron/database/schema.ts of the
 * Siltflow desktop app. Only fields needed for import are included.
 */

export interface DocumentRow {
  id: string;
  title: string;
  original_name: string | null;
  total_pages: number | null;
  metadata: string | null; // serialized JSON
  folder_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AnnotationRow {
  id: string;
  document_id: string;
  type: string; // "highlight" | "underline" | "text" | ...
  text: string | null;
  page_number: number | null;
  embed_data: string; // serialized JSON with positional/rect data
  kind: string; // "annotation" | "manual" | ...
  created_at: string;
  updated_at: string;
}

export interface AIResultRow {
  annotation_id: string;
  document_id: string;
  data: string; // serialized JSON — AI translation/explanation/etc.
  version: number; // AI data schema version
  created_at: string;
  updated_at: string;
}

export interface SummaryRow {
  document_id: string;
  text: string;
  is_ai_generated: number; // 0 or 1
  source_lang: string | null;
  created_at: string;
  updated_at: string;
}

export interface FSRSCardRow {
  annotation_id: string;
  document_id: string;
  data: string; // serialized JSON — ts-fsrs Card object
  created_at: string;
  updated_at: string;
}

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Pared AI result data (unpacked from the `data` JSON string). */
export interface ParsedAIResult {
  translation?: string;
  explanation?: string;
  [key: string]: unknown;
}

/** Grouped data for a single document, ready for Markdown generation. */
export interface DocumentImportData {
  doc: DocumentRow;
  annotations: AnnotationRow[];
  aiResults: Map<string, ParsedAIResult>; // keyed by annotation_id
  aiVersion: number; // max ai_result version across annotations (0 if none)
  summary: SummaryRow | null;
  fsrsCards: FSRSCardRow[];
  /** Resolved folder path in the Obsidian vault (empty string = root of output dir). */
  folderPath: string;
}

/** The index file tracking all past imports. */
export interface ImportIndex {
  lastImport: string;
  dbPath: string;
  documents: Record<
    string,
    {
      file: string;
      annotations: number;
      lastSync: string;
    }
  >;
}
