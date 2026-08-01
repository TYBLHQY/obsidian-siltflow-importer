/**
 * Post-build script: copy sql.js WASM file to the source tree so esbuild
 * can embed it into the bundle (loader: { ".wasm": "base64" }).
 *
 * The plugin stays a single self-contained main.js — the Obsidian community
 * installer only ships main.js / manifest.json / styles.css, so the wasm must
 * be inlined rather than shipped as a separate file.
 *
 * Usage: node scripts/copy-wasm.mjs
 */
import { copyFileSync, existsSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const wasmSource = join(
  rootDir,
  "node_modules",
  "sql.js",
  "dist",
  "sql-wasm.wasm",
);

const wasmDest = join(rootDir, "src", "sql-wasm.wasm");

if (!existsSync(wasmSource)) {
  console.error("❌ sql-wasm.wasm not found in node_modules/sql.js/dist/");
  process.exit(1);
}

copyFileSync(wasmSource, wasmDest);
const wasmSizeKb = (statSync(wasmSource).size / 1024).toFixed(0);
console.log(`✅ Copied sql-wasm.wasm (${wasmSizeKb} KB) -> ${wasmDest}`);
