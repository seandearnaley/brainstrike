import { PGlite } from '@electric-sql/pglite';

// Determine if vector extension should be disabled. Tests control this via DISABLE_VECTOR_EXTENSION.
function vectorDisabled(): boolean {
  return process.env['DISABLE_VECTOR_EXTENSION'] === 'true';
}

// Async function to load vector extension
async function loadVectorExtension() {
  if (vectorDisabled()) {
    return null;
  }

  try {
    // Dynamic import for pgvector extension (ES module compatible)
    const { vector } = await import('@electric-sql/pglite/vector');
    return vector;
  } catch (_e) {
    // pgvector extension not available, use null
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

    // Use vector extension if available, otherwise use basic PGlite
    if (vector) {
      return normalizedDataDir
        ? new PGlite({ dataDir: normalizedDataDir, extensions: { vector } })
        : new PGlite({ extensions: { vector } });
    }

    return normalizedDataDir ? new PGlite(normalizedDataDir) : new PGlite();
  }
}

export const wasmLoader = WasmLoader.getInstance();
