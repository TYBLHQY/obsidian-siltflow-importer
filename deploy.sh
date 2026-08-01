#!/usr/bin/env bash
# Build and deploy the plugin to the Obsidian vault.
# Usage: ./deploy.sh

set -euo pipefail

PLUGIN_DIR="/data/workspace/code-repo/obsidian-plugin-proj/obsidian-siltflow-importer"
VAULT_PLUGIN_DIR="/data/workspace/obsidian-repo/new-obsidian-repo/.obsidian/plugins/siltflow-importer"

cd "$PLUGIN_DIR"

echo "==> Building..."
pnpm build

echo "==> Deploying to vault..."
mkdir -p "$VAULT_PLUGIN_DIR"
cp main.js manifest.json styles.css icon.svg "$VAULT_PLUGIN_DIR/"

echo "==> Done"
ls -lh "$VAULT_PLUGIN_DIR"
