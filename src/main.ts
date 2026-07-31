/**
 * Siltflow Importer — Obsidian Plugin entry point.
 *
 * Registers:
 *  - "Import Siltflow database" command — one-click or file-picker import
 *  - "Change Siltflow database" command — always opens file picker
 *  - Ribbon icon for quick access
 *  - Settings tab for configuration
 */
import { Notice, Plugin, addIcon } from "obsidian";
import { existsSync } from "fs";
import type { App } from "obsidian";
import { setWasmPath } from "./db";
import {
  SiltflowImporterSettingTab,
  DEFAULT_SETTINGS,
  type SiltflowImporterSettings,
} from "./settings";
import { importDatabase, type ImportResult } from "./importer";
import { DocumentSelectionModal } from "./modal";

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
      this.openImportModal();
    });

    // Commands
    this.addCommand({
      id: "import-siltflow-db",
      name: "Import Siltflow database",
      callback: () => this.openImportModal(),
    });

    this.addCommand({
      id: "change-siltflow-db",
      name: "Change Siltflow database",
      callback: () => this.openImportModal(true),
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
   * Open the import modal. The modal handles its own loading animation
   * internally — the plugin just opens it and reacts to user decisions.
   */
  private openImportModal(forceFilePicker = false): void {
    const modal = new DocumentSelectionModal(this.app, {
      mode: this.settings.incrementalMode,
      onModeChange: (mode) => {
        this.settings.incrementalMode = mode;
        this.saveSettings();
      },
      getDbPath: async () => {
        let dbPath = this.settings.siltflowDbPath;

        if (!dbPath || forceFilePicker || !existsSync(dbPath)) {
          const picked = await this.pickDatabaseFile();
          if (!picked) throw new Error("cancelled"); // user cancelled file picker
          dbPath = picked;
          this.settings.siltflowDbPath = dbPath;
          await this.saveSettings();
        }

        if (!existsSync(dbPath)) {
          throw new Error(`Database not found: ${dbPath}`);
        }
        return dbPath;
      },
      onImport: async (selectedIds) => {
        const dbPath = this.settings.siltflowDbPath;
        const result: ImportResult = await importDatabase(
          this.app,
          dbPath,
          this.settings,
          selectedIds,
        );
        new Notice(
          `✅ Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`,
          8000,
        );
      },
      onError: (msg) => {
        new Notice(msg);
      },
    });

    modal.open();
  }

  // -----------------------------------------------------------------------
  // File picker
  // -----------------------------------------------------------------------

  private async pickDatabaseFile(): Promise<string | null> {
    try {
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
}
