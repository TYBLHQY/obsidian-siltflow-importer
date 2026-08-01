/**
 * Plugin settings with setting tab UI.
 *
 * Settings are defined declaratively via `getSettingDefinitions()` (Obsidian
 * 1.13+), which makes them searchable in the settings search. `getControlValue`
 * / `setControlValue` bridge the flat control keys to the nested
 * `includeTypes` object and persist on change.
 */
import { App, Notice, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
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

  /** Resolve a control key to the current settings value. */
  override getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    switch (key) {
      case "siltflowDbPath":
        return s.siltflowDbPath;
      case "outputFolder":
        return s.outputFolder;
      case "incrementalMode":
        return s.incrementalMode;
      case "calloutFold":
        return s.calloutFold;
      case "skipImportConfirm":
        return s.skipImportConfirm;
      case "includeTypes.word":
        return s.includeTypes.word;
      case "includeTypes.phrase":
        return s.includeTypes.phrase;
      case "includeTypes.sentence":
        return s.includeTypes.sentence;
      default:
        return undefined;
    }
  }

  /** Persist a control key to the settings object and save. */
  override setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key) {
      case "siltflowDbPath":
        s.siltflowDbPath = typeof value === "string" ? value : "";
        break;
      case "outputFolder":
        s.outputFolder = typeof value === "string" && value ? value : "Siltflow";
        break;
      case "incrementalMode":
        s.incrementalMode = value === "overwrite" ? "overwrite" : "update";
        break;
      case "calloutFold":
        s.calloutFold =
          value === "expanded" || value === "collapsed" || value === "none"
            ? value
            : "collapsed";
        break;
      case "skipImportConfirm":
        s.skipImportConfirm = value === true;
        break;
      case "includeTypes.word":
        s.includeTypes.word = value === true;
        break;
      case "includeTypes.phrase":
        s.includeTypes.phrase = value === true;
        break;
      case "includeTypes.sentence":
        s.includeTypes.sentence = value === true;
        break;
      default:
        break;
    }
    return this.plugin.saveSettings();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      // ── Path section ────────────────────────────────────────────
      {
        type: "group",
        heading: "路径",
        items: [
          {
            name: "数据库文件",
            desc: "Siltflow 的 data.db 路径。",
            control: {
              type: "text",
              key: "siltflowDbPath",
              placeholder: "~/Siltflow/.siltflow/data.db",
            },
          },
          {
            name: "输出目录",
            desc: "导入笔记的存放位置（vault 内相对路径）。",
            control: {
              type: "text",
              key: "outputFolder",
              placeholder: "Siltflow",
            },
          },
        ],
      },

      // ── Content section ─────────────────────────────────────────
      {
        type: "group",
        heading: "内容",
        items: [
          {
            name: "导入单词",
            desc: "词条类标注（如 virtue）。",
            control: { type: "toggle", key: "includeTypes.word" },
          },
          {
            name: "导入短语",
            desc: "短语类标注（如 to be sure）。",
            control: { type: "toggle", key: "includeTypes.phrase" },
          },
          {
            name: "导入句子",
            desc: "句子类标注。",
            control: { type: "toggle", key: "includeTypes.sentence" },
          },
        ],
      },

      // ── Import section ──────────────────────────────────────────
      {
        type: "group",
        heading: "导入",
        items: [
          {
            name: "导入模式",
            desc: "同步：按 updated_at 增/改/删已导入标注。覆盖：重建全部笔记。",
            control: {
              type: "dropdown",
              key: "incrementalMode",
              options: { update: "同步", overwrite: "覆盖" },
            },
          },
          {
            name: "卡片折叠",
            desc: "标注卡片的默认折叠状态。",
            control: {
              type: "dropdown",
              key: "calloutFold",
              options: { expanded: "展开", collapsed: "折叠", none: "不可折叠" },
            },
          },
          {
            name: "同步已导入笔记",
            desc: "将已导入笔记的卡片折叠状态改写为当前设置",
            render: (setting) => {
              setting.setName("同步已导入笔记");
              setting.setDesc("将已导入笔记的卡片折叠状态改写为当前设置");
              setting.addButton((button) =>
                button
                  .setButtonText("同步已导入笔记")
                  .setTooltip("将已导入笔记的卡片折叠状态改写为当前设置")
                  .onClick(() => {
                    if (this.plugin.importBusy) {
                      new Notice("⚠️ 导入正在进行中，请稍候。");
                      return;
                    }
                    void (async () => {
                      const n = await syncCalloutFolds(
                        this.app.vault,
                        this.plugin.settings.outputFolder,
                        this.plugin.settings.calloutFold,
                      );
                      new Notice(`✅ 已同步 ${n} 篇笔记的折叠状态`);
                    })();
                  }),
              );
            },
          },
          {
            name: "跳过导入确认",
            desc: "开启后点击侧边栏按钮或命令直接导入，不再弹出确认框。",
            control: { type: "toggle", key: "skipImportConfirm" },
          },
        ],
      },

      // ── Version info ─────────────────────────────────────────────
      {
        type: "group",
        heading: "版本信息",
        items: [
          { name: "插件数据格式版本", desc: String(INDEX_FORMAT_VERSION) },
          {
            name: "数据库版本",
            desc: "读取中…",
            render: (setting) => {
              setting.setName("数据库版本");
              setting.setDesc("读取中…");
              void getDatabaseVersion(this.plugin.settings.siltflowDbPath).then(
                (v) => {
                  if (v === null) {
                    setting.descEl.setText("无法读取（检查数据库路径）");
                    return;
                  }
                  setting.descEl.setText(String(v));
                },
              );
            },
          },
        ],
      },
    ];
  }
}
