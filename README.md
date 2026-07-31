# Siltflow Importer

Import your [Siltflow](https://github.com/TYBLHQY/siltflow) language learning data into Obsidian as structured Markdown notes.

## Features

- **One-click import** — read Siltflow's SQLite database and convert to `.md` files
- **Bilingual annotations** — original text + AI translation + explanations in Obsidian callouts
- **Incremental import** — only add new annotations, never overwrite your edits
- **Auto-generated Base dashboard** — browse, filter, sort all imported documents via Obsidian Bases
- **Selective import** — pick which documents to import with a checkbox modal
- **AI version tracking** — annotations track AI schema version for future upgrades

## Usage

1. Open the Obsidian Settings → Siltflow Importer
2. Set the path to your Siltflow `data.db` file (usually at `<vault>/.siltflow/data.db`)
3. Set the output folder inside your Obsidian vault
4. Run "Import Siltflow database" from the command palette or click the ribbon icon
5. Pick which documents to import, choose incremental mode, and import
6. Open `_Siltflow.base` in the output folder to browse your data as a database

## Output Format

Each Siltflow document becomes one `.md` file:

```markdown
---
siltflow_doc_id: "abc123"
siltflow_source: "article.pdf"
siltflow_ai_version: 1
pages: 12
total_cards: 5
---

# Article Title

> [!summary]- AI Summary
> The article discusses...

---

## Annotations

> [!highlight]+ Page 3
> **原文**: Original text here
>
> **翻译**: Translation here
>
> **解释**: Explanations...

```

## Requirements

- Obsidian 1.9.0+ (for Bases support)
- A Siltflow vault with `data.db`
- Desktop only (uses Node.js `fs` for file reading)
