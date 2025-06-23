declare module '@electric-sql/pglite/nodefs' {
  export class NodeFS {
    constructor(dataDir: string);
  }
}

declare module '@electric-sql/pglite' {
  export interface PGliteOptions {
    // biome-ignore lint/suspicious/noExplicitAny: FileSystem interface varies by implementation
    fs?: any;
  }

  export class PGlite {
    constructor(options?: PGliteOptions);
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    exec(sql: string): Promise<void>;
    close(): Promise<void>;
  }
}
