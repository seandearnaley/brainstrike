import { PGlite } from '@electric-sql/pglite';

// Determine if vector extension should be disabled. Tests control this via DISABLE_VECTOR_EXTENSION.
function vectorDisabled(): boolean {
  return process.env['DISABLE_VECTOR_EXTENSION'] === 'true';
}

function requireVectorStrict(): boolean {
  // Local-first modes that mandate pgvector being available
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })?.process?.env || {};
  const flags = [env['LOCAL_FIRST_DB'], env['PGLITE_EXPECTED'], env['REQUIRE_PGVECTOR']];
  const requested = flags.some((v) => String(v ?? '').toLowerCase() === 'true');
  const isTest = String(env['NODE_ENV'] ?? '').toLowerCase() === 'test';
  // In test environments, only enforce when explicitly requested
  if (isTest) {
    return String(env['REQUIRE_PGVECTOR_TEST'] ?? '').toLowerCase() === 'true';
  }
  return requested;
}

// Async function to load vector extension
async function loadVectorExtension() {
  if (vectorDisabled()) {
    if (requireVectorStrict()) {
      throw new Error('pgvector extension disabled via environment but required in strict mode');
    }
    return null;
  }

  try {
    // Dynamic import for pgvector extension (ES module compatible)
    const { vector } = await import('@electric-sql/pglite/vector');
    return vector;
  } catch (e) {
    if (requireVectorStrict()) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`pgvector extension is required but failed to load: ${msg}`);
    }
    // pgvector extension not available and not strictly required
    return null;
  }
}

class WasmLoader {
  private static instance: WasmLoader;
  private wasmLoadPromise: Promise<void> | null = null;
  private isLoaded = false;

  private constructor() {}

  static getInstance(): WasmLoader {
    if (!WasmLoader.instance) {
      WasmLoader.instance = new WasmLoader();
    }
    return WasmLoader.instance;
  }

  ensureWasmLoaded(): Promise<void> {
    if (this.isLoaded) {
      return Promise.resolve();
    }

    if (this.wasmLoadPromise) {
      return this.wasmLoadPromise;
    }

    this.wasmLoadPromise = this.loadWasm();
    return this.wasmLoadPromise;
  }

  private async loadWasm(): Promise<void> {
    try {
      // Load vector extension asynchronously
      const vector = await loadVectorExtension();

      // Create a temporary PGlite instance to trigger WASM loading
      // Always use true in-memory storage to avoid persisting between tests/runs
      const tempDbPath = 'memory://';

      // Use basic PGlite if vector extension is not available
      const tempDb = vector
        ? new PGlite({ dataDir: tempDbPath, extensions: { vector } })
        : new PGlite(tempDbPath);

      // Ensure the database is ready (this loads the WASM)
      await tempDb.query('SELECT 1');

      // Close the temporary database
      await tempDb.close();

      this.isLoaded = true;
    } catch (error) {
      this.wasmLoadPromise = null;
      throw error;
    }
  }

  async createPGlite(dataDir?: string): Promise<PGlite> {
    await this.ensureWasmLoaded();

    // Load vector extension asynchronously
    const vector = await loadVectorExtension();

    // Normalize in-memory indicator: map legacy ':memory:' to 'memory://'
    const normalizedDataDir = dataDir === ':memory:' ? 'memory://' : dataDir;

    // Use vector extension if available, otherwise (only if not strict) use basic PGlite
    if (vector) {
      return normalizedDataDir
        ? new PGlite({ dataDir: normalizedDataDir, extensions: { vector } })
        : new PGlite({ extensions: { vector } });
    }

    if (requireVectorStrict()) {
      throw new Error('pgvector is required (strict mode) but not available');
    }

    return normalizedDataDir ? new PGlite(normalizedDataDir) : new PGlite();
  }
}

export const wasmLoader = WasmLoader.getInstance();
