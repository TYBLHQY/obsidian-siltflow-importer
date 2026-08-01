# Siltflow Importer

Import your [Siltflow](https://github.com/TYBLHQY/siltflow) language-learning data into Obsidian as Markdown notes with bilingual AI annotation cards.

- Click the ribbon icon or run "Import Siltflow database" to sync your Siltflow SQLite database into the vault as structured notes — one per document, with an AI summary and a callout card per annotation.
- Incremental sync updates only changed annotations; per-type filters include only words, phrases, or sentences.
- Install from the community marketplace, or copy `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/TYBLHQY/obsidian-siltflow-importer/releases) into `.obsidian/plugins/siltflow-importer/`.
- Requires Obsidian 1.13+ (desktop). Reads your `data.db` directly via Node.js — everything stays local, nothing is uploaded.

Build locally with `npm install && npm run build`.
