/**
 * Plugin settings with setting tab UI.
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SiltflowImporterPlugin from "./main";
import { syncCalloutFolds, getDatabaseVersion, INDEX_FORMAT_VERSION } from "./importer";

// ---------------------------------------------------------------------------
// Settings interface
// ---------------------------------------------------------------------------

export interface SiltflowImporterSettings {
  /** Path to the Siltflow data.db file on disk. */
  siltflowDbPath: string;
  /** Output folder inside the Obsidian vault (relative to root). */
  outputFolder: string;
  /** Incremental import mode. */
  incrementalMode: "update" | "overwrite";
  /** Fold state of each annotation callout in the note. */
  calloutFold: "expanded" | "collapsed" | "none";
  /** Per-granularity include toggles for V2 annotations (word/phrase/sentence). */
  includeTypes: {
    word: boolean;
    phrase: boolean;
    sentence: boolean;
  };
  /** Skip the import confirmation dialog and import directly on ribbon click. */
  skipImportConfirm: boolean;
}

export const DEFAULT_SETTINGS: SiltflowImporterSettings = {
  siltflowDbPath: "",
  outputFolder: "Siltflow",
  incrementalMode: "update",
  calloutFold: "collapsed",
  includeTypes: {
    word: true,
    phrase: true,
    sentence: false,
  },
  skipImportConfirm: false,
};

// ---------------------------------------------------------------------------
// Setting tab
// ---------------------------------------------------------------------------

export class SiltflowImporterSettingTab extends PluginSettingTab {
  plugin: SiltflowImporterPlugin;

  constructor(app: App, plugin: SiltflowImporterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Path section ────────────────────────────────────────────

    new Setting(containerEl).setHeading().setName("路径");

    new Setting(containerEl)
      .setName("数据库文件")
      .setDesc("Siltflow 的 data.db 路径。")
      .addText((text) =>
        text
          .setPlaceholder("~/Siltflow/.siltflow/data.db")
          .setValue(this.plugin.settings.siltflowDbPath)
          .onChange(async (value) => {
            this.plugin.settings.siltflowDbPath = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("输出目录")
      .setDesc("导入笔记的存放位置（vault 内相对路径）。")
      .addText((text) =>
        text
          .setPlaceholder("Siltflow")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value || "Siltflow";
            await this.plugin.saveSettings();
          }),
      );

    // ── Content section ─────────────────────────────────────────

    new Setting(containerEl).setHeading().setName("内容");

    const typeToggles: Array<{
      key: "word" | "phrase" | "sentence";
      label: string;
      desc: string;
    }> = [
      { key: "word", label: "单词", desc: "词条类标注（如 virtue）。" },
      { key: "phrase", label: "短语", desc: "短语类标注（如 to be sure）。" },
      { key: "sentence", label: "句子", desc: "句子类标注。" },
    ];
    for (const t of typeToggles) {
      new Setting(containerEl)
        .setName(`导入${t.label}`)
        .setDesc(t.desc)
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.includeTypes[t.key])
            .onChange(async (value) => {
              this.plugin.settings.includeTypes[t.key] = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    // ── Import section ──────────────────────────────────────────

    new Setting(containerEl).setHeading().setName("导入");

    new Setting(containerEl)
      .setName("导入模式")
      .setDesc("同步：按 updated_at 增/改/删已导入标注。覆盖：重建全部笔记。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("update", "同步")
          .addOption("overwrite", "覆盖")
          .setValue(this.plugin.settings.incrementalMode)
          .onChange(async (value) => {
            this.plugin.settings.incrementalMode = value as
              | "update"
              | "overwrite";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("卡片折叠")
      .setDesc("标注卡片的默认折叠状态。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("expanded", "展开")
          .addOption("collapsed", "折叠")
          .addOption("none", "不可折叠")
          .setValue(this.plugin.settings.calloutFold)
          .onChange(async (value) => {
            this.plugin.settings.calloutFold = value as
              | "expanded"
              | "collapsed"
              | "none";
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("同步已导入笔记")
          .setTooltip("将已导入笔记的卡片折叠状态改写为当前设置")
          .onClick(async () => {
            if (this.plugin.importBusy) {
              new Notice("⚠️ 导入正在进行中，请稍候。");
              return;
            }
            const n = await syncCalloutFolds(
              this.app.vault,
              this.plugin.settings.outputFolder,
              this.plugin.settings.calloutFold,
            );
            new Notice(`✅ 已同步 ${n} 篇笔记的折叠状态`);
          }),
      );

    new Setting(containerEl)
      .setName("跳过导入确认")
      .setDesc("开启后点击侧边栏按钮或命令直接导入，不再弹出确认框。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.skipImportConfirm)
          .onChange(async (value) => {
            this.plugin.settings.skipImportConfirm = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Version info ─────────────────────────────────────────────

    new Setting(containerEl).setHeading().setName("版本信息");

    new Setting(containerEl)
      .setName("插件数据格式版本")
      .setDesc(String(INDEX_FORMAT_VERSION));

    const dbVersion = new Setting(containerEl)
      .setName("数据库版本")
      .setDesc("读取中…");

    // Read the source DB version asynchronously.
    void getDatabaseVersion(this.plugin.settings.siltflowDbPath).then((v) => {
      if (v === null) {
        dbVersion.descEl.setText("无法读取（检查数据库路径）");
        return;
      }
      dbVersion.descEl.setText(String(v));
    });
  }
}
