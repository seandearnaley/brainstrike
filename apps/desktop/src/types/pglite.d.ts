declare module '@electric-sql/pglite/nodefs' {
  export class NodeFS {
    constructor(dataDir: string);
  }
}

declare module '@electric-sql/pglite' {
  export interface PGliteOptions {
    dataDir?: string;
    // biome-ignore lint/suspicious/noExplicitAny: FileSystem interface varies by implementation
    fs?: any;
    // biome-ignore lint/suspicious/noExplicitAny: Extensions interface varies by implementation
    extensions?: any;
  }

  export class PGlite {
    constructor(options?: PGliteOptions | string);
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    exec(sql: string): Promise<void>;
    close(): Promise<void>;
  }
}
