/**
 * SQL.js wrapper — opens Siltflow .db files and runs queries.
 *
 * sql.js is a WASM-compiled SQLite that works in Obsidian's sandboxed
 * renderer environment (unlike better-sqlite3 which requires native addons).
 *
 * WASM loading strategy:
 * The sql-wasm.wasm file (~645KB) is copied to the plugin directory by the
 * build script. At runtime we override sql.js's default locateFile to load
 * it from disk via Node's readFileSync. This avoids:
 *   - CDN dependency (plugin works offline)
 *   - fetch() which isn't available in Obsidian's file:// context
 *   - The ~1.2MB base64-encoded fallback that sql.js embeds
 */
import initSqlJs, { type Database } from "sql.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// WASM loading
// ---------------------------------------------------------------------------

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

/**
 * We need to locate the .wasm file relative to main.js at runtime.
 *
 * ObservablePlugin provides the plugin's directory path via `this.manifest.dir`
 * at runtime, but we can't access that in this module. Instead we try known
 * locations and the constructor accepts an optional config.
 */

/** Resolved path to sql-wasm.wasm, set by the plugin on init. */
let wasmPath: string | null = null;

/**
 * Set the WASM file path before first database open.
 * Called from main.ts with the plugin's directory path.
 */
export function setWasmPath(pluginDir: string): void {
  const candidate = join(pluginDir, "sql-wasm.wasm");
  if (existsSync(candidate)) {
    wasmPath = candidate;
  } else {
    console.warn(
      "[Siltflow Importer] sql-wasm.wasm not found at",
      candidate,
    );
  }
}

/**
 * Initialize sql.js with the bundled WASM file read from disk.
 */
function getSql(): ReturnType<typeof initSqlJs> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file: string) => {
        if (wasmPath && existsSync(wasmPath)) {
          // Return a custom path — sql.js will try to read it.
          // For Node.js environments (which Obsidian desktop is),
          // we can read the WASM bytes ourselves.
          // But since sql.js's default code uses fetch(), we need
          // a different approach — read the bytes manually and
          // pass them via the `wasmBinary` config option.
          return file; // fallback, won't work in file:// context
        }
        return file;
      },
    });
  }
  return sqlPromise;
}

// When wasmPath is set, override the initialization to pass binary directly.
// We do this by letting the user call init with the binary data.
async function getSqlWithBinary(): Promise<
  Awaited<ReturnType<typeof initSqlJs>>
> {
  if (!sqlPromise) {
    if (!wasmPath || !existsSync(wasmPath)) {
      // Fallback: use sql.js's own loading mechanism
      sqlPromise = initSqlJs({});
    } else {
      const wasmBinary = readFileSync(wasmPath);
      sqlPromise = initSqlJs({ wasmBinary });
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
  const SQL = await getSqlWithBinary();
  const buffer = readFileSync(filePath);
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
  if (params) {
    stmt.bind(params);
  }

  const results: T[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as T;
    results.push(row);
  }
  stmt.free();
  return results;
}

/**
 * Close the database and release WASM memory.
 */
export function closeDatabase(db: Database): void {
  db.close();
}
