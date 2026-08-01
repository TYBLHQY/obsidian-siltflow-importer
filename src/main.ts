/**
 * Siltflow Importer — Obsidian Plugin entry point.
 *
 * Registers:
 *  - Ribbon icon + "Import Siltflow database" command — confirm dialog, then
 *    sync-import every document from the configured DB in one go
 *  - "Change Siltflow database" command — pick a different data.db
 *  - Settings tab for configuration
 */
import { Modal, Notice, Plugin, Setting, addIcon } from "obsidian";
import { existsSync } from "fs";
import type { App } from "obsidian";
import {
  SiltflowImporterSettingTab,
  DEFAULT_SETTINGS,
  type SiltflowImporterSettings,
} from "./settings";
import { importDatabase, type ImportResult } from "./importer";

// Custom ribbon icon — user's original SVG
const RIBBON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24">
    <path fill="currentColor" d="M15 2c1.94 0 3.59.7 4.95 2.05C21.3 5.41 22 7.06 22 9c0 1.56-.5 2.96-1.42 4.2c-.94 1.23-2.14 2.07-3.61 2.5l.03-.32V15c0-2.19-.77-4.07-2.35-5.65S11.19 7 9 7h-.37l-.33.03c.43-1.47 1.27-2.67 2.5-3.61C12.04 2.5 13.44 2 15 2M9 8a7 7 0 0 1 7 7a7 7 0 0 1-7 7a7 7 0 0 1-7-7a7 7 0 0 1 7-7m0 2a5 5 0 0 0-5 5a5 5 0 0 0 5 5a5 5 0 0 0 5-5a5 5 0 0 0-5-5"/>
</svg>`;

// ---------------------------------------------------------------------------
// Plugin class
// ---------------------------------------------------------------------------

export default class SiltflowImporterPlugin extends Plugin {
  settings!: SiltflowImporterSettings;
  /** True while an import is running — prevents concurrent imports. */
  private isImporting = false;

  /** Whether an import is currently running (checked by the settings tab). */
  get importBusy(): boolean {
    return this.isImporting;
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    // Settings tab
    this.addSettingTab(new SiltflowImporterSettingTab(this.app, this));

    // Register custom icon and add to ribbon
    addIcon("siltflow-importer", RIBBON_ICON);
    this.addRibbonIcon("siltflow-importer", "Import Siltflow database", () => {
      this.confirmAndImport();
    });

    // Commands
    this.addCommand({
      id: "import-database",
      name: "Import Siltflow database",
      callback: () => this.confirmAndImport(),
    });

    this.addCommand({
      id: "change-database",
      name: "Change Siltflow database",
      callback: async () => {
        const picked = await this.pickDatabaseFile();
        if (picked) {
          this.settings.siltflowDbPath = picked;
          await this.saveSettings();
          new Notice("✅ 数据库文件已更新");
        }
      },
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // -----------------------------------------------------------------------
  // Import flow — confirm, then sync-import everything
  // -----------------------------------------------------------------------

  /**
   * Resolve a usable DB path: the configured one if it exists, otherwise let
   * the user pick a file. Returns null when cancelled or unavailable.
   */
  private async resolveDbPath(): Promise<string | null> {
    let dbPath = this.settings.siltflowDbPath;
    if (!dbPath || !existsSync(dbPath)) {
      const picked = await this.pickDatabaseFile();
      if (!picked) return null;
      dbPath = picked;
      this.settings.siltflowDbPath = dbPath;
      await this.saveSettings();
    }
    return dbPath;
  }

  /**
   * Run a full sync-import of every document, showing a confirmation dialog
   * first unless the user has chosen to skip it. Used by the ribbon icon and
   * the "Import" command.
   */
  private confirmAndImport(): void {
    // Skip the dialog when the user opted out.
    if (this.settings.skipImportConfirm) {
      this.runImport();
      return;
    }

    const modal = new ImportConfirmModal(
      this.app,
      this.settings.siltflowDbPath || "（未配置）",
      this.settings.outputFolder || "（未配置）",
      async (skipNextTime) => {
        if (skipNextTime) {
          this.settings.skipImportConfirm = true;
          await this.saveSettings();
        }
        await this.runImport();
      },
    );
    modal.open();
  }

  /**
   * Resolve the DB path (picking a file if needed) and run the import.
   * Surfaces errors as Notices.
   */
  private async runImport(): Promise<void> {
    if (this.isImporting) {
      new Notice("⚠️ 导入正在进行中，请稍候。");
      return;
    }
    this.isImporting = true;
    try {
      const dbPath = await this.resolveDbPath();
      if (!dbPath) return;
      const result: ImportResult = await importDatabase(
        this.app,
        dbPath,
        this.settings,
        [], // all documents
      );
      new Notice(
        `✅ 导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}`,
        8000,
      );
    } catch (err) {
      new Notice(
        `❌ 导入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.isImporting = false;
    }
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
        title: "选择 Siltflow 数据库",
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
        "⚠️ 无法打开文件选择器（仅桌面版支持）。请在设置中手动填写数据库路径。",
      );
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Import confirmation modal
// ---------------------------------------------------------------------------

/**
 * Confirmation dialog shown before a full sync-import. Built with the DOM
 * (`contentEl.createEl`) rather than `setContent(string)` so line breaks and
 * styling render reliably. Shows the configured DB path + output folder and a
 * "don't ask again" checkbox.
 */
class ImportConfirmModal extends Modal {
  private readonly dbPath: string;
  private readonly outFolder: string;
  private readonly onConfirm: (skipNextTime: boolean) => Promise<void>;
  private skipNextTime = false;

  constructor(
    app: App,
    dbPath: string,
    outFolder: string,
    onConfirm: (skipNextTime: boolean) => Promise<void>,
  ) {
    super(app);
    this.dbPath = dbPath;
    this.outFolder = outFolder;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("导入 Siltflow 数据库");

    contentEl.createDiv().setText(
      "将按当前设置同步导入全部文档。",
    );

    // Path list
    const paths = contentEl.createDiv("siltflow-confirm-paths");
    const label = (text: string) => paths.createDiv().createEl("strong", { text });
    const path = (text: string) =>
      paths.createDiv("siltflow-confirm-path").setText(text);
    label("数据库");
    path(this.dbPath);
    paths.createDiv({ attr: { style: "height: 8px" } });
    label("输出目录");
    path(this.outFolder);

    // "Don't ask again" checkbox
    new Setting(contentEl)
      .setName("以后不再询问")
      .setDesc("下次点击按钮或命令时直接导入。")
      .addToggle((toggle) =>
        toggle.onChange((value) => {
          this.skipNextTime = value;
        }),
      );

    // Buttons
    const buttonRow = contentEl.createDiv({ cls: "siltflow-confirm-buttons" });
    const cancelBtn = buttonRow.createEl("button", {
      text: "取消",
      cls: "mod-ghost",
    });
    cancelBtn.addEventListener("click", () => this.close());

    const confirmBtn = buttonRow.createEl("button", {
      text: "开始导入",
      cls: "mod-cta",
    });
    confirmBtn.addEventListener("click", () => {
      const skip = this.skipNextTime;
      this.close();
      void this.onConfirm(skip);
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.titleEl.empty();
  }
}
