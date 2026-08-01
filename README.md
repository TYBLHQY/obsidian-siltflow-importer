# Siltflow Importer

Import your [Siltflow](https://github.com/TYBLHQY/siltflow) language learning data into Obsidian as Markdown notes.

## Features

- **One-click import** — run the "Import Siltflow database" command or click the ribbon icon to sync all documents from your Siltflow SQLite database
- **Bilingual annotation cards** — each annotation renders as a callout card with the AI translation and sections (CEFR & Lemma, Meanings, Definitions, Examples, Collocations, Synonyms)
- **Incremental sync** — add/change/delete detection based on each annotation's `updated_at`; unchanged documents are skipped
- **Granular type filters** — import only words, phrases, or sentences as you prefer
- **Structured output** — YAML frontmatter + AI summary callout + one card per annotation, all in plain Markdown

## Usage

1. Open Obsidian Settings → **Siltflow Importer**
2. Set the path to your Siltflow `data.db` file
3. Set the output folder inside your vault
4. Click the ribbon icon (or run "Import Siltflow database") and confirm
5. The sync imports every document; a notice reports created / updated / skipped counts

The import mode (sync vs full overwrite) and per-type toggles are configured in the plugin settings.

## Output

Each Siltflow document becomes one `.md` file:

```markdown
---
siltflow_doc_id: "abc123"
siltflow_source: "article.pdf"
siltflow_imported: 2026-08-01
siltflow_ai_version: 2
pages: 12
tags:
  - siltflow
---

# Article Title

> [!summary]- Summary
> The article discusses...

---

## Annotations

> [!siltflow]- virtue
> <!-- siltflow-annotation: fd91bb30..., ai-version: 2 -->
>
> **美德**
>
> **CEFR & Lemma**
> `B2` `virtue`
>
> **Meanings**
> - `NOUN` 美德
>
> **Examples**
> - Honesty is a virtue. / 诚实是一种美德。
```

The `_meta/` folder holds the sync state:
- `_siltflow_import.json` — index format version + last import info
- `documents.jsonl` — one line per imported document
- `anns/<doc>.jsonl` — one line per annotation with its `importedAt` timestamp

These are managed automatically — don't edit them by hand.

## Requirements

- Obsidian 1.6.6+ (desktop)
- A Siltflow vault with its `data.db`
- Desktop only — the plugin reads the database via Node.js and uses the native file picker

> **Privacy**: the plugin reads the Siltflow database you point it at (which may live outside your vault) and writes Markdown into your vault. Everything stays local — nothing is uploaded.

## Install

From source:

```bash
pnpm install
pnpm build
```

Copy `main.js`, `manifest.json`, `styles.css`, `sql-wasm.wasm`, and `sql-wasm.js` into `.obsidian/plugins/siltflow-importer/`, then enable the plugin in Obsidian.

Releases on GitHub include all five files, so the community installer works out of the box.

## License

MIT
