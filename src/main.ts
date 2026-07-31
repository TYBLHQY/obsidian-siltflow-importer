/**
 * Siltflow Importer — Obsidian Plugin entry point.
 *
 * Registers:
 *  - "Import Siltflow database" command — one-click or file-picker import
 *  - "Change Siltflow database" command — always opens file picker
 *  - Ribbon icon for quick access
 *  - Settings tab for configuration
 */
import { Notice, Plugin, Modal, addIcon } from "obsidian";
import { existsSync } from "fs";
import type { App } from "obsidian";
import { setWasmPath } from "./db";
import {
  SiltflowImporterSettingTab,
  DEFAULT_SETTINGS,
  type SiltflowImporterSettings,
} from "./settings";
import { importDatabase, type ImportResult } from "./importer";
import { openDatabase, queryAll, closeDatabase } from "./db";
import type { DocumentRow } from "./types";

// Custom ribbon icon — user's original SVG
const RIBBON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24">
    <path fill="currentColor" d="M15 2c1.94 0 3.59.7 4.95 2.05C21.3 5.41 22 7.06 22 9c0 1.56-.5 2.96-1.42 4.2c-.94 1.23-2.14 2.07-3.61 2.5l.03-.32V15c0-2.19-.77-4.07-2.35-5.65S11.19 7 9 7h-.37l-.33.03c.43-1.47 1.27-2.67 2.5-3.61C12.04 2.5 13.44 2 15 2M9 8a7 7 0 0 1 7 7a7 7 0 0 1-7 7a7 7 0 0 1-7-7a7 7 0 0 1 7-7m0 2a5 5 0 0 0-5 5a5 5 0 0 0 5 5a5 5 0 0 0 5-5a5 5 0 0 0-5-5"/>
</svg>`;

// ---------------------------------------------------------------------------
// Plugin class
// ---------------------------------------------------------------------------

export default class SiltflowImporterPlugin extends Plugin {
  settings!: SiltflowImporterSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Configure sql.js WASM path and ribbon icon
    const pluginDir = this.manifest.dir || "";
    const adapter = this.app.vault.adapter;
    const basePath = (adapter as unknown as { basePath?: string }).basePath;
    if (basePath && pluginDir) {
      const fullPath = basePath + "/" + pluginDir;
      setWasmPath(fullPath);
    }

    // Settings tab
    this.addSettingTab(new SiltflowImporterSettingTab(this.app, this));

    // Register custom icon and add to ribbon
    addIcon("siltflow-importer", RIBBON_ICON);
    this.addRibbonIcon("siltflow-importer", "Import Siltflow database", () => {
      this.runImport();
    });

    // Commands
    this.addCommand({
      id: "import-siltflow-db",
      name: "Import Siltflow database",
      callback: () => this.runImport(),
    });

    this.addCommand({
      id: "change-siltflow-db",
      name: "Change Siltflow database",
      callback: () => this.runImport(true),
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // -----------------------------------------------------------------------
  // Import flow
  // -----------------------------------------------------------------------

  /**
   * Main import entry point.
   *
   * @param forceFilePicker If true, always show file picker (ignore saved path).
   */
  private async runImport(forceFilePicker = false): Promise<void> {
    let dbPath = this.settings.siltflowDbPath;

    // Determine the database file path
    if (!dbPath || forceFilePicker || !existsSync(dbPath)) {
      const picked = await this.pickDatabaseFile();
      if (!picked) return; // user cancelled
      dbPath = picked;
      this.settings.siltflowDbPath = dbPath;
      await this.saveSettings();
    }

    // Verify the file exists
    if (!existsSync(dbPath)) {
      new Notice(`❌ Siltflow database not found: ${dbPath}`);
      return;
    }

    // Open the DB to read document list
    let documents: DocumentRow[] = [];
    try {
      const db = await openDatabase(dbPath);
      try {
        documents = queryAll<DocumentRow>(db, "SELECT * FROM documents");
      } finally {
        closeDatabase(db);
      }
    } catch (err) {
      new Notice(`❌ Failed to open database: ${err}`);
      console.error("[Siltflow Importer] DB open error:", err);
      return;
    }

    if (documents.length === 0) {
      new Notice("⚠️ No documents found in the Siltflow database.");
      return;
    }

    // Show document selection modal
    const selectedIds = await this.showDocumentModal(documents);
    if (selectedIds === null) return; // user cancelled
    if (selectedIds.length === 0) {
      new Notice("⚠️ No documents selected.");
      return;
    }

    // Run import
    const notice = new Notice("Importing...", 0);
    try {
      const result: ImportResult = await importDatabase(
        this.app,
        dbPath,
        this.settings,
        selectedIds,
      );
      notice.hide();
      new Notice(
        `✅ Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`,
        8000,
      );
    } catch (err) {
      notice.hide();
      new Notice(`❌ Import failed: ${err}`);
      console.error("[Siltflow Importer] Import error:", err);
    }
  }

  // -----------------------------------------------------------------------
  // File picker
  // -----------------------------------------------------------------------

  private async pickDatabaseFile(): Promise<string | null> {
    // Use Electron's dialog via the Obsidian require (available in desktop)
    try {
      // Obsidian desktop exposes Electron APIs via require
      const remote = (window as unknown as { require: (m: string) => unknown }).require(
        "electron",
      ) as { remote: { dialog: { showOpenDialog: (opts: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }> } } };
      const { dialog } = remote.remote;
      const result = await dialog.showOpenDialog({
        title: "Select Siltflow database",
        filters: [
          { name: "SQLite Database", extensions: ["db"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    } catch {
      new Notice(
        "⚠️ File picker requires Electron (desktop-only). Set the path in settings manually.",
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Document selection modal
  // -----------------------------------------------------------------------

  private showDocumentModal(
    documents: DocumentRow[],
  ): Promise<string[] | null> {
    return new Promise((resolve) => {
      new DocumentSelectionModal(
        this.app,
        documents,
        this.settings.incrementalMode,
        (mode) => {
          this.settings.incrementalMode = mode;
          this.saveSettings();
        },
        resolve,
      ).open();
    });
  }
}

// ---------------------------------------------------------------------------
// Document Selection Modal
// ---------------------------------------------------------------------------

class DocumentSelectionModal extends Modal {
  private documents: DocumentRow[];
  private checkboxes: Map<string, HTMLInputElement> = new Map();
  private mode: string;
  private onModeChange: (mode: "append" | "update" | "overwrite") => void;
  private resolve: (ids: string[] | null) => void;

  constructor(
    app: App,
    documents: DocumentRow[],
    mode: string,
    onModeChange: (mode: "append" | "update" | "overwrite") => void,
    resolve: (ids: string[] | null) => void,
  ) {
    super(app);
    this.documents = documents;
    this.mode = mode;
    this.onModeChange = onModeChange;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl, modalEl, titleEl } = this;

    // ── Modal container ────────────────────────────────────────
    modalEl.addClass("siltflow-importer-modal");

    // ── Header ─────────────────────────────────────────────────
    titleEl.empty();
    titleEl.createEl("span", { text: "Siltflow" }).addClass("siltflow-brand");
    titleEl.createSpan({ text: "导入" });

    // ── Body ───────────────────────────────────────────────────
    contentEl.empty();

    // Info bar
    const infoBar = contentEl.createDiv("siltflow-info-bar");
    infoBar.createSpan({
      text: `共 ${this.documents.length} 个文档 — 勾选要导入的文档`,
    });

    // ── Document list (scrollable) ─────────────────────────────
    const listWrapper = contentEl.createDiv("siltflow-list-wrapper");

    for (const doc of this.documents) {
      const row = listWrapper.createDiv("siltflow-doc-row");

      const checkbox = row.createEl("input", {
        type: "checkbox",
        attr: { checked: "true" },
      });
      checkbox.addClass("siltflow-checkbox");
      this.checkboxes.set(doc.id, checkbox);

      const label = row.createEl("label", "siltflow-doc-label");
      const titleLine = label.createDiv("siltflow-doc-title");
      titleLine.setText(doc.title);

      const metaLine = label.createDiv("siltflow-doc-meta");
      if (doc.total_pages) {
        metaLine.createSpan({ text: `${doc.total_pages} 页` });
      }
      if (doc.original_name && doc.original_name !== doc.title) {
        metaLine.createSpan({ text: `来源: ${doc.original_name}` });
      }
    }

    // ── Footer ─────────────────────────────────────────────────
    const footer = contentEl.createDiv("siltflow-footer");

    // Select all / none
    const selectRow = footer.createDiv("siltflow-select-row");
    const selectAllBtn = selectRow.createEl("button", {
      text: "全选",
      cls: "siltflow-btn-ghost",
    });
    selectAllBtn.addEventListener("click", () => {
      this.checkboxes.forEach((cb) => (cb.checked = true));
    });

    const selectNoneBtn = selectRow.createEl("button", {
      text: "取消",
      cls: "siltflow-btn-ghost",
    });
    selectNoneBtn.addEventListener("click", () => {
      this.checkboxes.forEach((cb) => (cb.checked = false));
    });

    const selectedCount = selectRow.createSpan("siltflow-selected-count");
    selectedCount.setText(`已选 ${this.documents.length} 个`);
    // Update count on changes
    const updateCount = () => {
      let n = 0;
      this.checkboxes.forEach((cb) => (n += cb.checked ? 1 : 0));
      selectedCount.setText(`已选 ${n} 个`);
    };
    this.checkboxes.forEach((cb) => {
      cb.addEventListener("change", updateCount);
    });

    // Mode selector
    const modeRow = footer.createDiv("siltflow-mode-row");
    modeRow.createSpan({ text: "导入模式", cls: "siltflow-label" });
    const modeSelect = modeRow.createEl("select", "dropdown");
    const modes: Array<{ value: string; label: string; desc: string }> = [
      { value: "append", label: "增量追加", desc: "只添加新文档和标注" },
      { value: "update", label: "增量更新", desc: "追加 + 更新已有 AI 结果" },
      { value: "overwrite", label: "全量覆盖", desc: "删除全部重新生成" },
    ];
    for (const m of modes) {
      modeSelect.createEl("option", {
        text: `${m.label} — ${m.desc}`,
        attr: { value: m.value },
      });
    }
    modeSelect.value = this.mode;
    modeSelect.addEventListener("change", () => {
      this.mode = modeSelect.value;
    });

    // Action buttons
    const buttonRow = footer.createDiv("siltflow-button-row");

    const cancelBtn = buttonRow.createEl("button", {
      text: "取消",
      cls: "siltflow-btn-ghost",
    });
    cancelBtn.addEventListener("click", () => {
      this.resolve(null);
      this.close();
    });

    const importBtn = buttonRow.createEl("button", {
      text: "开始导入",
      cls: "mod-cta siltflow-import-btn",
    });
    importBtn.addEventListener("click", () => {
      const selected: string[] = [];
      this.checkboxes.forEach((cb, id) => {
        if (cb.checked) selected.push(id);
      });
      this.onModeChange(this.mode as "append" | "update" | "overwrite");
      this.resolve(selected);
      this.close();
    });
  }

  onClose(): void {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    titleEl.empty();
  }
}
