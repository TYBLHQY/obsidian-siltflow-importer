# Siltflow Importer

把 [Siltflow](https://github.com/TYBLHQY/siltflow) 的语言学习数据导入 Obsidian，生成带双语 AI 标注卡片的 Markdown 笔记。

## 功能

- **一键导入** — 点击侧边栏图标或运行命令，同步 Siltflow SQLite 数据库中的全部文档
- **双语标注卡片** — 每条标注渲染为 callout 卡片，含 AI 翻译与释义分区（CEFR & Lemma、Meanings、Definitions、Examples、Collocations、Synonyms）
- **增量同步** — 按 `updated_at` 自动增/改/删已导入的标注，未变化的文档自动跳过
- **类型筛选** — 只导入单词、短语或句子
- **结构化输出** — YAML frontmatter + AI 摘要 + 每条标注一张卡片，全部为纯 Markdown

## 使用

1. 打开 Obsidian 设置 → **Siltflow Importer**
2. 设置 Siltflow `data.db` 文件的路径
3. 设置 vault 内的输出目录
4. 点击侧边栏图标（或运行 "Import Siltflow database" 命令）并确认

每次导入完成后，右下角会提示新增 / 更新 / 跳过的文档数。导入模式（同步 / 覆盖）与类型开关均可在设置中调整。

## 输出

每个文档生成一个 `.md` 文件：YAML frontmatter（来源、页码、标签）→ 标题 → AI 摘要 → `## Annotations` 下按标注顺序排列的卡片。增量同步的状态文件存放在输出目录的 `_meta/` 下，自动管理，无需手动维护。

## 安装

- **社区市场**：Obsidian 设置 → 社区插件 → 浏览，搜索 "Siltflow Importer"。
- **手动安装**：从 GitHub Releases 下载 `main.js`、`manifest.json`、`styles.css`，放入 `.obsidian/plugins/siltflow-importer/`，然后在设置中启用。

## 要求

- Obsidian 1.13.0+（桌面版）
- 一个 Siltflow vault 及其 `data.db`

## 隐私

- 插件通过 Node.js `fs` 直接读取你配置路径下的 Siltflow SQLite 数据库（位于 vault 之外），并将生成的 Markdown 写入 vault。
- 全程本地运行——不上传任何数据，无网络请求，无遥测。

## 开发

```bash
npm install
npm run build   # 构建到 main.js
npm run dev     # 监听模式
```

## License

MIT
