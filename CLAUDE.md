# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Obsidian plugin that imports Siltflow's SQLite database (`data.db`) into an Obsidian vault as structured Markdown notes with bilingual AI annotations.

Upstream Siltflow project: `/data/workspace/code-repo/web-proj/siltflow` — Drizzle schema at `electron/database/schema.ts`, AI data types at `src/types/annotation.ts`.

## Commands

> ⚠️ **包管理器是 npm，不是 pnpm。** 项目用 `package-lock.json`（tracked），`.gitignore` 排除了 `pnpm-lock.yaml`。**不要用 pnpm 跑命令**——没有 `pnpm-lock.yaml` 时 pnpm 会触发 `pnpm install`（可能被安全策略拦截），还会自动生成 `pnpm-workspace.yaml` 污染工作区（本仓库踩过，记得删掉该文件并改用 npm）。

```bash
npm run build   # tsc type-check → esbuild bundle → copy WASM
bash deploy.sh  # build + copy output files to local Obsidian vault plugins dir
npm run dev     # watch mode (esbuild + WASM copy)
npm run lint    # eslint src/
```

`main.js` / `*.wasm` / `src/sql-wasm.wasm` / `*.js.map` 均被 `.gitignore` 排除——它们是构建产物，**不提交**。CI 的 release job 负责在 tag 时构建发布产物。

## 开发环境

- **Node 24 + npm**（`package-lock.json` 已提交）。装依赖：`npm ci`（干净安装，CI 同款）。
- **构建产物不入库**：`main.js` 由 `tsc -noEmit` + `esbuild.config.mjs production` 生成，发布由 CI 完成，本地不用提交。
- **sql.js WASM**：`scripts/copy-wasm.mjs` 在 build 前把 `node_modules/sql.js` 的 `sql-wasm.wasm` 拷到 `src/sql-wasm.wasm`（源目录，非产物）。`main.js` 里通过相对路径加载它，所以插件发布包必须包含 wasm。
- **本地部署到 Obsidian vault**：`deploy.sh` 构建后拷贝 `main.js manifest.json styles.css icon.svg` 到 `VAULT_PLUGIN_DIR`（硬编码路径 `/data/workspace/obsidian-repo/new-obsidian-repo/.obsidian/plugins/siltflow-importer`）。改完代码用 `bash deploy.sh` 即可在 Obsidian 里热重载（需在 vault 中 `Developer mode` → `Reload app without saving`）。
- 上游 Siltflow 桌面端项目在 `/data/workspace/code-repo/web-proj/siltflow`，其 Drizzle schema 在 `electron/database/schema.ts`、AI 数据类型在 `src/types/annotation.ts`。本仓库的 `src/types.ts` 与之保持同步，上游 schema/字段名变更时需同步（如 v6 的 `context` → `documentContext`）。

## Architecture

Single-entry esbuild bundle: `src/main.ts` → `main.js` (CJS, ES2018, `obsidian`/`electron` externalized).

**Data flow:**
```
main.ts (Plugin.onload: ribbon + commands)
  → main.ts (confirmAndImport: ConfirmationModal → resolve DB → importDatabase)
    → importer.ts (importDatabase: SQLite queries → group by doc → sync diff → write)
      → formatter.ts (buildMarkdownNote: frontmatter + summary + card callouts)
```

**Key modules:**

| File | Role |
|------|------|
| `src/main.ts` | Plugin lifecycle, ribbon icon, commands, settings. Ribbon + "Import" command show a ConfirmationModal then sync-import all docs; "Change Siltflow database" opens a file picker |
| `src/importer.ts` | Full pipeline: open DB, query tables, group annotations by doc, sync diff, write one `.md` per document + jsonl indexes. Also exports `validateImportConfig` and `syncCalloutFolds` |
| `src/formatter.ts` | Build one Markdown note per document: YAML frontmatter + title + AI summary callout + one card-style callout per annotation. AI data rendering matches upstream Siltflow V1/V2 card layout |
| `src/settings.ts` | Settings interface + settings tab UI |
| `src/db.ts` | sql.js WASM wrapper — open `.db`, run SELECT, close |
| `src/types.ts` | DB row types matching Siltflow Drizzle schema; `ParsedAIResult` union for V1/V2 AI data; `DocumentRenderData` for the render pipeline |

**AI result versions:**
- **V1** (`AIAnnotationDataV1`): flat fields — `translation`, `definitions[]`, `examples[]`, `collocations[]`, `pronunciation.ipa`, `metadata.{difficulty,register}`
- **V2** (`AIAnnotationDataV2`): structured — `input.{type,lemma,source_lang}` + `output` (shape depends on `input.type`: word→`meanings[]`, phrase→`translation`+`examples[]`, sentence→`translation`)

**Incremental import (sync mode):** the main index `_siltflow_import.json` holds
only `formatVersion` / `lastImport` / `dbPath`. Document records live in
`_meta/documents.jsonl` (one line per doc: file, anns file, summary time), and
each document's annotation sync state in `_meta/anns/<doc>.jsonl` (one line per
annotation: `{ "id", "importedAt" }`) — so no index file grows with the word
count. Annotation IDs are embedded as `<!-- siltflow-annotation: ID -->` in
markdown. Sync mode re-renders a document's note when any annotation is new,
has a newer `updated_at` (annotation or its ai_result) than `importedAt`, or
was deleted from the DB — a full re-render covers add/change/delete. The
summary re-renders when its `updated_at` changed. Unchanged docs are skipped.
`overwrite` mode deletes and rebuilds everything.

**WASM:** sql.js requires `sql-wasm.wasm` + `sql-wasm.js` in the plugin dir. `scripts/copy-wasm.mjs` copies from `node_modules` post-build.

## Output format

One `.md` file per document (single-file layout — no `words/` subfolder, no `.base` dashboard):
1. YAML frontmatter (`siltflow_doc_id`, `siltflow_source`, `pages`, `tags: [siltflow]`)
2. `# Title`
3. AI summary callout (if present)
4. `## Annotations` → one card-style callout (`> [!siltflow]`) per annotation:
   - title = word/phrase; body = big translation, then AI sections (CEFR & Lemma, Meanings, Definitions, Examples, Collocations, Synonyms)
   - sections are emitted only when they have content; empty fields never appear
   - each callout embeds `<!-- siltflow-annotation: ID, ai-version: N -->` for incremental diffing
   - semantic `<span class="...">` wrappers (`card-translation`) let `styles.css` style the cards reliably — Obsidian parses markdown inside these inline spans

## Settings

- `calloutFold`: `"expanded"` | `"collapsed"` | `"none"` — controls annotation callout folding
- `includeTypes`: per-granularity toggles for V2 annotations (`word` / `phrase` / `sentence`)
- `incrementalMode`: `"update"` (sync add/change/delete) | `"overwrite"` (full rebuild), default `"update"`
- `skipImportConfirm`: when on, the ribbon / import command skips the confirmation dialog and imports directly. The dialog shows the configured DB path + output folder and offers this checkbox.

Import always includes AI translations/explanations, skips docs with zero
annotations, and drops `highlight`-kind annotations (pure PDF marks with no
AI data).

**Safety guard:** `validateImportConfig` runs at the top of `importDatabase`
and throws before any vault write when the config is invalid — the DB path is
empty, or the output folder is empty / not a safe vault-relative path (no
absolute paths, `..` traversal, drive letters, or illegal filename chars).
The modal surfaces the error as a Notice.

## 发布流程

发版统一走 **patch/minor bump**（`1.0.x` → 下一个），tag 触发 CI。

### 版本号一致性（三处必须同步）

| 文件 | 作用 |
|------|------|
| `package.json` → `version` | npm 元数据，构建脚本日志显示 |
| `manifest.json` → `version` | **Obsidian 社区插件显示的版本**（真实版本真相） |
| `versions.json` → 顶部新键 | 版本 → `minAppVersion` 映射表，供社区库判断兼容性 |

> 三处不一致会造成混乱（历史上出现过 package.json/manifest.json 漂移）。**改版本时三处一起改**，并确认 `manifest.json` 与 `package.json` 一致。

### 操作步骤

```bash
# 1. 同步三处版本号（package.json + manifest.json + versions.json）
#    versions.json 顶部加一行 "1.0.x": "1.13.0"（minAppVersion 与上一版相同即可）

# 2. 功能改动 + bump 分开提交（历史惯例：feat/fix 单独 commit）
git add src/... 
git commit -m "feat: <描述>"
git add package.json manifest.json versions.json
git commit -m "chore: bump version to 1.0.4"

# 3. 打轻量 tag（无 v 前缀，与历史 1.0.0~1.0.3 一致；CI 监听 tags: "*"）
git tag 1.0.4

# 4. 先推 master、再推 tag
git push origin master
git push origin 1.0.4
```

### CI 行为

- `.github/workflows/release.yml`：监听 `push: tags: "*"`，`npm ci` → `npm run build` → 打包 `main.js manifest.json styles.css` → attest build provenance → 用 `softprops/action-gh-release` 创建 GitHub Release。`main.js` 不入库，完全由 CI 在 tag 时构建。
- `.github/workflows/release-notes.yml`：监听同一 tag，用 `generateReleaseNotes` 自动生成 release notes（对比上一个 tag 的 commit range），**无需手写 notes**。
- 两个 workflow 并行触发；上一个版本（1.0.3）Release 约 22s 跑完。
- 验证发布成功：
  ```bash
  gh run list --repo TYBLHQY/obsidian-siltflow-importer --limit 4
  gh release view 1.0.4 --repo TYBLHQY/obsidian-siltflow-importer
  ```

### 发版前检查清单

1. 功能改动已提交（`git status` 干净，除构建产物外无多余文件）
2. 三处版本号一致
3. 本地模拟 CI：`npm ci && npm run build` 通过，产物齐全
4. 确认无 `pnpm-workspace.yaml` / `pnpm-lock.yaml` 等污染文件
