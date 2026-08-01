/**
 * Plugin settings with setting tab UI.
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SiltflowImporterPlugin from "./main";
import { syncCalloutFolds } from "./importer";

// ---------------------------------------------------------------------------
// Settings interface
// ---------------------------------------------------------------------------

export interface SiltflowImporterSettings {
  /** Path to the Siltflow data.db file on disk. */
  siltflowDbPath: string;
  /** Output folder inside the Obsidian vault (relative to root). */
  outputFolder: string;
  /** Incremental import mode. */
  incrementalMode: "append" | "update" | "overwrite";
  /** Fold state of each annotation callout in the note. */
  calloutFold: "expanded" | "collapsed" | "none";
  /** Per-granularity include toggles for V2 annotations (word/phrase/sentence). */
  includeTypes: {
    word: boolean;
    phrase: boolean;
    sentence: boolean;
  };
}

export const DEFAULT_SETTINGS: SiltflowImporterSettings = {
  siltflowDbPath: "",
  outputFolder: "Siltflow",
  incrementalMode: "append",
  calloutFold: "collapsed",
  includeTypes: {
    word: true,
    phrase: true,
    sentence: true,
  },
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

    containerEl.createEl("h3", { text: "路径配置" });

    new Setting(containerEl)
      .setName("Siltflow 数据库位置")
      .setDesc("Siltflow vault 中的 data.db 文件路径。设置后每次导入无需重复选择。")
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
      .setName("Obsidian 内输出目录")
      .setDesc("导入的 Markdown 文件将保存在此目录下（相对于 vault 根目录）。")
      .addText((text) =>
        text
          .setPlaceholder("Siltflow")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value || "Siltflow";
            await this.plugin.saveSettings();
          }),
      );

    // ── V2 granularity filters ───────────────────────────────────

    containerEl.createEl("h4", { text: "V2 标注类型" });

    const typeToggles: Array<{
      key: "word" | "phrase" | "sentence";
      label: string;
      desc: string;
    }> = [
      { key: "word", label: "包含单词", desc: "词条类标注（如 virtue）。" },
      { key: "phrase", label: "包含短语", desc: "短语类标注（如 to be sure）。" },
      { key: "sentence", label: "包含句子", desc: "句子类标注。" },
    ];
    for (const t of typeToggles) {
      new Setting(containerEl)
        .setName(t.label)
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

    // ── Import strategy section ─────────────────────────────────

    containerEl.createEl("h3", { text: "导入策略" });

    new Setting(containerEl)
      .setName("增量导入模式")
      .setDesc(
        "追加：只添加新标注。更新：追加 + 更新已有 AI 结果。覆盖：删除全部重新导入。",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("append", "增量追加")
          .addOption("update", "增量更新")
          .addOption("overwrite", "全量覆盖")
          .setValue(this.plugin.settings.incrementalMode)
          .onChange(async (value) => {
            this.plugin.settings.incrementalMode = value as
              | "append"
              | "update"
              | "overwrite";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("标注卡片折叠状态")
      .setDesc("默认折叠：卡片收起。默认展开：卡片展开。不可折叠：无折叠按钮。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("expanded", "默认展开")
          .addOption("collapsed", "默认折叠")
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
          .setButtonText("同步已导入")
          .setTooltip("把已导入笔记的卡片折叠状态改写为当前设置")
          .onClick(async () => {
            const n = await syncCalloutFolds(
              this.app.vault,
              this.plugin.settings.outputFolder,
              this.plugin.settings.calloutFold,
            );
            new Notice(`✅ 已同步 ${n} 篇笔记的折叠状态`);
          }),
      );
  }
}
