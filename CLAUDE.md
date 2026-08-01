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
  → modal.ts (DocumentSelectionModal: loading spinner → checkbox list)
    → importer.ts (importDatabase: SQLite queries → group by doc → diff → write)
      → formatter.ts (buildMarkdownNote: frontmatter + summary + card callouts)
```

**Key modules:**

| File | Role |
|------|------|
| `src/main.ts` | Plugin lifecycle, ribbon icon, commands, settings |
| `src/modal.ts` | Two-phase modal: loading spinner then doc selection with checkboxes |
| `src/importer.ts` | Full pipeline: open DB, query tables, group annotations by doc, incremental diff, write one `.md` per document + `_siltflow_import.json` |
| `src/formatter.ts` | Build one Markdown note per document: YAML frontmatter + title + AI summary callout + one card-style callout per annotation. AI data rendering matches upstream Siltflow V1/V2 card layout |
| `src/settings.ts` | Settings interface + settings tab UI |
| `src/db.ts` | sql.js WASM wrapper — open `.db`, run SELECT, close |
| `src/types.ts` | DB row types matching Siltflow Drizzle schema; `ParsedAIResult` union for V1/V2 AI data; `DocumentRenderData` for the render pipeline |

**AI result versions:**
- **V1** (`AIAnnotationDataV1`): flat fields — `translation`, `definitions[]`, `examples[]`, `collocations[]`, `pronunciation.ipa`, `metadata.{difficulty,register}`
- **V2** (`AIAnnotationDataV2`): structured — `input.{type,lemma,source_lang}` + `output` (shape depends on `input.type`: word→`meanings[]`, phrase→`translation`+`examples[]`, sentence→`translation`)

**Incremental import:** `_siltflow_import.json` tracks document→file mapping. Annotation IDs embedded as `<!-- siltflow-annotation: ID -->` in markdown for dedup. In "append" mode new annotations are appended to the existing note via `buildCardBlocks`; "update" re-renders the whole note when any annotation's AI version changed; "overwrite" always re-renders.

**WASM:** sql.js requires `sql-wasm.wasm` + `sql-wasm.js` in the plugin dir. `scripts/copy-wasm.mjs` copies from `node_modules` post-build.

## Output format

One `.md` file per document (single-file layout — no `words/` subfolder, no `.base` dashboard):
1. YAML frontmatter (`siltflow_doc_id`, `siltflow_source`, `pages`, `total_cards`, `new_cards`, `due_cards`, `tags: [siltflow]`)
2. `# Title`
3. AI summary callout (if present)
4. `## Annotations` → one card-style callout (`> [!siltflow]`) per annotation:
   - title = word/phrase; body = big translation, meta line (`en-US → zh-CN` · Page), then AI sections (CEFR & Lemma, Meanings, Definitions, Examples, Collocations, Synonyms) and an FSRS Review block
   - sections are emitted only when they have content; empty fields never appear
   - each callout embeds `<!-- siltflow-annotation: ID, ai-version: N -->` for incremental diffing
   - semantic `<span class="...">` wrappers (`card-translation`, `language-meta`, `review-block`) let `styles.css` style the cards reliably — Obsidian parses markdown inside these inline spans

## Settings

- `calloutFold`: `"expanded"` | `"collapsed"` | `"none"` — controls annotation callout folding
- `includeAIResults`: toggle AI translations/explanations in callouts
- `includeFSRSStats`: include the FSRS Review block in each card + frontmatter stats
- `incrementalMode`: `"append"` | `"update"` | `"overwrite"`
- `includeDocumentsWithoutAnnotations`: skip docs with zero annotations/cards
