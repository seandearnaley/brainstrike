type TursoBrowserWasmConnect = typeof import('@tursodatabase/database-wasm/vite')['connect'];

export type TursoBrowserWasmDatabase = Awaited<ReturnType<TursoBrowserWasmConnect>>;
export type TursoBrowserWasmStatement = Awaited<ReturnType<TursoBrowserWasmDatabase['prepare']>>;
export type TursoBrowserWasmRunResult = Awaited<ReturnType<TursoBrowserWasmStatement['run']>>;

export interface OpenTursoBrowserWasmDatabaseOptions {
  readonly path: string;
}

export async function openTursoBrowserWasmDatabase(
  options: OpenTursoBrowserWasmDatabaseOptions
): Promise<TursoBrowserWasmDatabase> {
  const path = options.path.trim();
  if (!path) {
    throw new Error('Turso browser WASM database path is required.');
  }
  if (typeof window === 'undefined') {
    throw new Error('Turso browser WASM database can only be opened in a browser runtime.');
  }

  const { connect } = await import('@tursodatabase/database-wasm/vite');
  return connect(path);
}
