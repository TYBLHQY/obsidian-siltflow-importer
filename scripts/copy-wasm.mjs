/**
 * Post-build script: copy sql.js WASM file to the plugin output directory.
 *
 * Obsidian plugins ship as a directory containing main.js, manifest.json,
 * and styles.css. The sql.js WASM file must also live in that directory
 * so the plugin can load it at runtime via readFileSync.
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

const wasmDest = join(rootDir, "sql-wasm.wasm");

if (!existsSync(wasmSource)) {
  console.error("❌ sql-wasm.wasm not found in node_modules/sql.js/dist/");
  process.exit(1);
}

copyFileSync(wasmSource, wasmDest);
const wasmSizeKb = (statSync(wasmSource).size / 1024).toFixed(0);
console.log(`✅ Copied sql-wasm.wasm (${wasmSizeKb} KB) -> ${wasmDest}`);

// Also copy the JS loader that sql.js's require() will resolve
const jsSource = join(rootDir, "node_modules", "sql.js", "dist", "sql-wasm.js");
const jsDest = join(rootDir, "sql-wasm.js");
if (existsSync(jsSource)) {
  copyFileSync(jsSource, jsDest);
  const jsSizeKb = (statSync(jsSource).size / 1024).toFixed(0);
  console.log(`✅ Copied sql-wasm.js (${jsSizeKb} KB) -> ${jsDest}`);
}
