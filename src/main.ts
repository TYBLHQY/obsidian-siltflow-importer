/**
 * Siltflow Importer — Obsidian Plugin entry point.
 *
 * Registers:
 *  - "Import Siltflow database" command — one-click or file-picker import
 *  - "Change Siltflow database" command — always opens file picker
 *  - Ribbon icon for quick access
 *  - Settings tab for configuration
 */
import { Notice, Plugin, Modal } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
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

// ---------------------------------------------------------------------------
// Plugin class
// ---------------------------------------------------------------------------

export default class SiltflowImporterPlugin extends Plugin {
  settings!: SiltflowImporterSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Configure sql.js WASM path (load from plugin directory)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifest = require("../manifest.json") as { id: string };
    try {
      const pluginDir = (this.app.vault.adapter as unknown as { basePath: string }).basePath +
        "/.obsidian/plugins/" + manifest.id;
      setWasmPath(pluginDir);
      // Also try the development path (project root)
      if (!existsSync(join(pluginDir, "sql-wasm.wasm"))) {
        setWasmPath(
          "/data/workspace/code-repo/obsidian-plugin-proj/obsidian-siltflow-importer",
        );
      }
    } catch {
      // Fallback: try common locations
      console.warn(
        "[Siltflow Importer] Could not determine plugin directory, falling back to CDN",
      );
    }

    // Settings tab
    this.addSettingTab(new SiltflowImporterSettingTab(this.app, this));

    // Ribbon icon
    this.addRibbonIcon("database", "Import Siltflow database", () => {
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
    const { contentEl } = this;

    contentEl.empty();
    contentEl.addClass("siltflow-importer-modal");

    contentEl.createEl("h3", { text: "导入 Siltflow 数据库" });

    // Document list
    const listContainer = contentEl.createDiv({
      cls: "siltflow-importer-list",
    });

    // Select all / deselect all buttons
    const toolbarRow = contentEl.createDiv({
      cls: "siltflow-importer-toolbar",
    });

    const selectAllBtn = toolbarRow.createEl("button", { text: "全选" });
    selectAllBtn.addEventListener("click", () => {
      this.checkboxes.forEach((cb) => (cb.checked = true));
    });

    const deselectAllBtn = toolbarRow.createEl("button", { text: "取消全选" });
    deselectAllBtn.addEventListener("click", () => {
      this.checkboxes.forEach((cb) => (cb.checked = false));
    });

    // Document checkboxes
    for (const doc of this.documents) {
      const row = listContainer.createDiv({
        cls: "siltflow-importer-row",
      });

      const label = row.createEl("label");
      const cb = label.createEl("input", {
        type: "checkbox",
        attr: { checked: "true" },
      });
      this.checkboxes.set(doc.id, cb);

      label.createSpan({ text: doc.title, cls: "siltflow-importer-title" });
    }

    // Incremental mode selector
    const modeContainer = contentEl.createDiv({
      cls: "siltflow-importer-mode",
    });

    modeContainer.createEl("span", { text: "增量模式: " });

    const modeSelect = modeContainer.createEl("select");
    const modes: Array<{ value: string; label: string }> = [
      { value: "append", label: "增量追加" },
      { value: "update", label: "增量更新" },
      { value: "overwrite", label: "全量覆盖" },
    ];
    for (const m of modes) {
      const opt = modeSelect.createEl("option", {
        text: m.label,
        attr: { value: m.value },
      });
      if (m.value === this.mode) {
        opt.selected = true;
      }
    }
    modeSelect.addEventListener("change", () => {
      this.mode = modeSelect.value;
    });

    // Action buttons
    const buttonRow = contentEl.createDiv({
      cls: "siltflow-importer-buttons",
    });

    const cancelBtn = buttonRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => {
      this.resolve(null);
      this.close();
    });

    const importBtn = buttonRow.createEl("button", {
      text: `导入选中 (${
        this.documents.filter(() => true).length
      } 个文档)`,
      cls: "mod-cta",
    });
    importBtn.addEventListener("click", () => {
      const selected: string[] = [];
      this.checkboxes.forEach((cb, id) => {
        if (cb.checked) selected.push(id);
      });

      // Save mode
      this.onModeChange(this.mode as "append" | "update" | "overwrite");

      this.resolve(selected);
      this.close();
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
