import type { Extension } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';

type VectorExtension = Extension;

let cachedVectorPromise: Promise<VectorExtension> | null = null;

async function loadVectorExtension(): Promise<VectorExtension> {
  if (!cachedVectorPromise) {
    cachedVectorPromise = (async () => {
      try {
        // Dynamic import for pgvector extension (ES module compatible)
        /* Stryker disable next-line StringLiteral */
        const { vector } = await import('@electric-sql/pglite/vector');
        return vector;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`pgvector extension is required and failed to load: ${message}`);
      }
    })();
  }

  return cachedVectorPromise;
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

      // Create a temporary PGlite instance to trigger WASM loading with pgvector
      const tempDbPath = 'memory://';
      const tempDb = new PGlite({ dataDir: tempDbPath, extensions: { vector } });

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

    return normalizedDataDir
      ? new PGlite({ dataDir: normalizedDataDir, extensions: { vector } })
      : new PGlite({ extensions: { vector } });
  }
}

export const wasmLoader = WasmLoader.getInstance();
