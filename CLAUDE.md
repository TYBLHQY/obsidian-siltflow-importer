# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Obsidian plugin that imports Siltflow's SQLite database (`data.db`) into an Obsidian vault as structured Markdown notes with bilingual AI annotations.

Upstream Siltflow project: `/data/workspace/code-repo/web-proj/siltflow` — Drizzle schema at `electron/database/schema.ts`, AI data types at `src/types/annotation.ts`.

## Commands

```bash
pnpm build    # tsc type-check → esbuild bundle → copy WASM
bash deploy.sh   # build + copy output files to local Obsidian vault plugins dir
pnpm dev      # watch mode (esbuild + WASM copy)
```

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
