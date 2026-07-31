declare module "sql.js" {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
  }

  interface Statement {
    bind(params: unknown[]): void;
    step(): boolean;
    getAsObject<T = Record<string, unknown>>(): T;
    free(): void;
  }

  function initSqlJs(config?: {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }): Promise<SqlJsStatic>;

  export default initSqlJs;
  export type { Database, SqlJsStatic, Statement };
}
