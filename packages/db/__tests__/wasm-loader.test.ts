import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let wasmLoader: typeof import('../src/wasm-loader').wasmLoader;
let PGliteMock: ReturnType<typeof vi.fn>;

describe('wasmLoader.ensureWasmLoaded', () => {
  beforeEach(async () => {
    // Clear all modules and reset state before each test
    vi.resetModules();
    vi.unmock('@electric-sql/pglite');
    vi.unmock('@electric-sql/pglite-pgvector');

    vi.doMock('@electric-sql/pglite', () => {
      PGliteMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.query = vi.fn().mockResolvedValue(undefined);
        this.close = vi.fn().mockResolvedValue(undefined);
      });
      return { PGlite: PGliteMock };
    });

    // Mock the vector extension
    vi.doMock('@electric-sql/pglite-pgvector', () => ({
      vector: {},
    }));

    // Import fresh module after mocking
    const wasmLoaderModule = await import('../src/wasm-loader');
    wasmLoader = wasmLoaderModule.wasmLoader;

    // Reset internal state using proper type casting
    const internalLoader = wasmLoader as unknown as {
      wasmLoadPromise: Promise<void> | null;
      isLoaded: boolean;
    };
    internalLoader.wasmLoadPromise = null;
    internalLoader.isLoaded = false;
  });

  afterEach(() => {
    vi.resetModules();
    vi.unmock('@electric-sql/pglite');
    vi.unmock('@electric-sql/pglite-pgvector');
  });

  it('returns the same promise when called twice', async () => {
    const promise1 = wasmLoader.ensureWasmLoaded();
    const promise2 = wasmLoader.ensureWasmLoaded();
    expect(promise1).toBe(promise2);
    await promise1;
  });

  it('resets wasmLoadPromise to null after rejection', async () => {
    // Reset modules to apply new mock
    vi.resetModules();

    // Mock vector extension to reject
    vi.doMock('@electric-sql/pglite-pgvector', () => ({
      get vector() {
        throw new Error('pgvector extension is required and failed to load: load fail');
      },
    }));

    // Mock live extension (successful)
    vi.doMock('@electric-sql/pglite/live', () => ({
      live: {},
    }));

    // Re-import the module with the failing mock
    const wasmLoaderModule = await import('../src/wasm-loader');
    const loader = wasmLoaderModule.wasmLoader;

    // Reset internal state
    const internalLoader = loader as unknown as {
      wasmLoadPromise: Promise<void> | null;
      isLoaded: boolean;
    };
    internalLoader.wasmLoadPromise = null;
    internalLoader.isLoaded = false;

    const promise = loader.ensureWasmLoaded();
    await expect(promise).rejects.toThrowError(/pgvector extension is required/);
    const internal = loader as unknown as { wasmLoadPromise: Promise<void> | null };
    expect(internal.wasmLoadPromise).toBeNull();
  });

  describe('disposeAll / disposeWasmLoader', () => {
    it('closes all cached DB instances and resets loader state', async () => {
      // Pre-load extensions so createPGlite can proceed
      vi.doMock('@electric-sql/pglite/live', () => ({ live: {} }));

      // Re-import to pick up live mock
      vi.resetModules();
      vi.doMock('@electric-sql/pglite', () => {
        PGliteMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
          this.query = vi.fn().mockResolvedValue(undefined);
          this.close = vi.fn().mockResolvedValue(undefined);
        });
        return { PGlite: PGliteMock };
      });
      vi.doMock('@electric-sql/pglite-pgvector', () => ({ vector: {} }));
      vi.doMock('@electric-sql/pglite/live', () => ({ live: {} }));

      const mod = await import('../src/wasm-loader');
      const loader = mod.wasmLoader;

      // Create a cached IDB instance
      const db = await loader.createPGlite('idb://test-dispose');
      expect(db).toBeDefined();

      // Verify it was cached
      const db2 = await loader.createPGlite('idb://test-dispose');
      expect(db2).toBe(db); // same cached instance

      // Dispose all
      await loader.disposeAll();

      // Verify close was called on the cached instance
      expect((db as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);

      // Verify internal state was reset
      const internal = loader as unknown as {
        dbCache: Map<string, unknown>;
        isLoaded: boolean;
        wasmLoadPromise: Promise<void> | null;
      };
      expect(internal.dbCache.size).toBe(0);
      expect(internal.isLoaded).toBe(false);
      expect(internal.wasmLoadPromise).toBeNull();
    });

    it('disposeWasmLoader resets extension caches and calls disposeAll', async () => {
      vi.resetModules();
      vi.doMock('@electric-sql/pglite', () => {
        PGliteMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
          this.query = vi.fn().mockResolvedValue(undefined);
          this.close = vi.fn().mockResolvedValue(undefined);
        });
        return { PGlite: PGliteMock };
      });
      vi.doMock('@electric-sql/pglite-pgvector', () => ({ vector: {} }));
      vi.doMock('@electric-sql/pglite/live', () => ({ live: {} }));

      const mod = await import('../src/wasm-loader');

      // Pre-load to populate extension caches
      await mod.wasmLoader.ensureWasmLoaded();

      const internal = mod.wasmLoader as unknown as { isLoaded: boolean };
      expect(internal.isLoaded).toBe(true);

      // disposeWasmLoader should reset everything
      await mod.disposeWasmLoader();

      expect(internal.isLoaded).toBe(false);
    });

    it('disposeAll handles close errors gracefully', async () => {
      vi.resetModules();
      vi.doMock('@electric-sql/pglite', () => {
        PGliteMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
          this.query = vi.fn().mockResolvedValue(undefined);
          this.close = vi.fn().mockRejectedValue(new Error('already closed'));
        });
        return { PGlite: PGliteMock };
      });
      vi.doMock('@electric-sql/pglite-pgvector', () => ({ vector: {} }));
      vi.doMock('@electric-sql/pglite/live', () => ({ live: {} }));

      const mod = await import('../src/wasm-loader');
      const loader = mod.wasmLoader;

      // Create a cached instance that will fail to close
      await loader.createPGlite('idb://test-error');

      // Should not throw even when close fails
      await expect(loader.disposeAll()).resolves.toBeUndefined();
    });
  });
});
