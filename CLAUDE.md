# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Obsidian plugin that imports Siltflow's SQLite database (`data.db`) into an Obsidian vault as structured Markdown notes with bilingual AI annotations.

Upstream Siltflow project: `/data/workspace/code-repo/web-proj/siltflow` — Drizzle schema at `electron/database/schema.ts`, AI data types at `src/types/annotation.ts`.

## Commands

```bash
npm run build    # tsc type-check → esbuild bundle → copy WASM
bash deploy.sh   # build + copy output files to local Obsidian vault plugins dir
npm run dev      # watch mode (esbuild + WASM copy)
```

## Architecture

Single-entry esbuild bundle: `src/main.ts` → `main.js` (CJS, ES2018, `obsidian`/`electron` externalized).

**Data flow:**
```
main.ts (Plugin.onload: ribbon + commands)
  → modal.ts (DocumentSelectionModal: loading spinner → checkbox list)
    → importer.ts (importDatabase: SQLite queries → group by doc → diff → write)
      → formatter.ts (buildMarkdownNote: frontmatter + callouts with AI data)
      → base-generator.ts (generateBaseFileContent: _Siltflow.base YAML)
```

**Key modules:**

| File | Role |
|------|------|
| `src/main.ts` | Plugin lifecycle, ribbon icon, commands, settings |
| `src/modal.ts` | Two-phase modal: loading spinner then doc selection with checkboxes |
| `src/importer.ts` | Full pipeline: open DB, query tables, group annotations by doc, incremental diff, write `.md` and `_siltflow_import.json` |
| `src/formatter.ts` | Build Markdown note with YAML frontmatter + Obsidian callouts. AI data rendering matches upstream Siltflow V1/V2 card layout |
| `src/base-generator.ts` | Generate/update `_Siltflow.base` (Obsidian Bases YAML). Custom YAML serializer with formula/formula quoting |
| `src/settings.ts` | Settings interface + settings tab UI |
| `src/db.ts` | sql.js WASM wrapper — open `.db`, run SELECT, close |
| `src/types.ts` | DB row types matching Siltflow Drizzle schema; `ParsedAIResult` union for V1/V2 AI data |

**AI result versions:**
- **V1** (`AIAnnotationDataV1`): flat fields — `translation`, `definitions[]`, `examples[]`, `collocations[]`, `pronunciation.ipa`, `metadata.{difficulty,register}`
- **V2** (`AIAnnotationDataV2`): structured — `input.{type,lemma,source_lang}` + `output` (shape depends on `input.type`: word→`meanings[]`, phrase→`translation`+`examples[]`, sentence→`translation`)

**Incremental import:** `_siltflow_import.json` tracks document→file mapping. Annotation IDs embedded as `<!-- siltflow-annotation: ID -->` in markdown for dedup.

**WASM:** sql.js requires `sql-wasm.wasm` + `sql-wasm.js` in the plugin dir. `scripts/copy-wasm.mjs` copies from `node_modules` post-build.

## Output format

Each document → one `.md` file with:
1. YAML frontmatter (`siltflow_doc_id`, `siltflow_source`, `pages`, `total_cards`, `tags: [siltflow]`)
2. `# Title`
3. AI summary callout (if present)
4. `## Annotations` → per-annotation callout with embedded ID comment, page, original text, then AI detail blocks (Translation, Meanings, Definitions, Examples, Collocations, etc.)

## Settings

- `calloutFold`: `"expanded"` | `"collapsed"` | `"none"` — controls annotation callout folding
- `includeAIResults`: toggle AI translations/explanations in callouts
- `incrementalMode`: `"append"` | `"update"` | `"overwrite"`
- `createBaseFile`: auto-generate `_Siltflow.base` dashboard
