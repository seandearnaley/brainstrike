import { PGlite } from '@electric-sql/pglite';

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
      // Create a temporary PGlite instance to trigger WASM loading
      // Use browser-compatible storage to avoid Node.js filesystem conflicts
      const isBrowser = typeof window !== 'undefined';
      const tempDbPath = isBrowser ? 'memory://' : ':memory:';
      const tempDb = new PGlite(tempDbPath);

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
    return new PGlite(dataDir);
  }
}

export const wasmLoader = WasmLoader.getInstance();
