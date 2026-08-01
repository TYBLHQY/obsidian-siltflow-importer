/**
 * SQL.js wrapper — opens Siltflow .db files and runs queries.
 *
 * sql.js is a WASM-compiled SQLite that works in Obsidian's sandboxed
 * renderer environment (unlike better-sqlite3 which requires native addons).
 *
 * WASM loading strategy:
 * The sql-wasm.wasm file is embedded into the bundle as a base64 string at
 * build time (esbuild `loader: { '.wasm': 'base64' }`) and decoded at runtime
 * into a Uint8Array for `initSqlJs({ wasmBinary })`. This keeps the plugin a
 * single self-contained main.js — the Obsidian community installer only ships
 * main.js / manifest.json / styles.css, so an external wasm file would never
 * be present on community installs.
 */
import initSqlJs, { type Database } from "sql.js";
import wasmBase64 from "./sql-wasm.wasm";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// WASM loading
// ---------------------------------------------------------------------------

let sqlPromise: Awaited<ReturnType<typeof initSqlJs>> | null = null;

/** Decode the build-time-embedded base64 wasm into a Uint8Array. */
function decodeWasm(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getSql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!sqlPromise) {
    try {
      sqlPromise = await initSqlJs({ wasmBinary: decodeWasm(wasmBase64) });
    } catch (err) {
      // Don't cache a failed init — clear it so a later call can retry.
      sqlPromise = null;
      throw err;
    }
  }
  return sqlPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a Siltflow .db file and return a sql.js Database instance.
 *
 * The entire DB is loaded into WASM memory — this is fine for Siltflow
 * database sizes (typically <100 MB even for large vaults).
 */
export async function openDatabase(filePath: string): Promise<Database> {
  const SQL = await getSql();
  // Desktop-only: fs.readFileSync is available in Obsidian's Electron
  // renderer. Guard for type safety (fs is untyped in some lint environments).
  const buffer =
    typeof readFileSync === "function"
      ? readFileSync(filePath)
      : new Uint8Array(0);
  return new SQL.Database(new Uint8Array(buffer));
}

/**
 * Run a SELECT query and return results as an array of typed objects.
 */
export function queryAll<T>(
  db: Database,
  sql: string,
  params?: unknown[],
): T[] {
  const stmt = db.prepare(sql);
  try {
    if (params) {
      stmt.bind(params);
    }

    const results: T[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject<T>();
      results.push(row);
    }
    return results;
  } finally {
    stmt.free();
  }
}

/**
 * Close the database and release WASM memory.
 */
export function closeDatabase(db: Database): void {
  db.close();
}
