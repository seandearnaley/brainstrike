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

  async ensureWasmLoaded(): Promise<void> {
    if (this.isLoaded) {
      return;
    }

    if (this.wasmLoadPromise) {
      return this.wasmLoadPromise;
    }

    this.wasmLoadPromise = this.loadWasm();
    await this.wasmLoadPromise;
  }

  private async loadWasm(): Promise<void> {
    try {
      // Create a temporary PGlite instance to trigger WASM loading
      // Use memory database to avoid file system conflicts
      const tempDb = new PGlite();

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
