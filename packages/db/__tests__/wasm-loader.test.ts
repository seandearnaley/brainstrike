import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let wasmLoader: typeof import('../src/wasm-loader').wasmLoader;
let PGliteMock: ReturnType<typeof vi.fn>;

describe('wasmLoader.ensureWasmLoaded', () => {
  beforeEach(async () => {
    // Clear all modules and reset state before each test
    vi.resetModules();
    vi.unmock('@electric-sql/pglite');
    vi.unmock('@electric-sql/pglite-pgvector');
    vi.unmock('@electric-sql/pglite/contrib/pg_trgm');

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

    // Mock the pg_trgm extension
    vi.doMock('@electric-sql/pglite/contrib/pg_trgm', () => ({
      pg_trgm: {},
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
    vi.unmock('@electric-sql/pglite/contrib/pg_trgm');
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

    // Mock pg_trgm extension (successful)
    vi.doMock('@electric-sql/pglite/contrib/pg_trgm', () => ({
      pg_trgm: {},
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

  it('rejects with the pg_trgm failure message when the trgm extension fails to load', async () => {
    // Reset modules to apply new mock
    vi.resetModules();

    // Mock vector extension (successful)
    vi.doMock('@electric-sql/pglite-pgvector', () => ({
      vector: {},
    }));

    // Mock live extension (successful)
    vi.doMock('@electric-sql/pglite/live', () => ({
      live: {},
    }));

    // Mock pg_trgm extension to reject
    vi.doMock('@electric-sql/pglite/contrib/pg_trgm', () => ({
      get pg_trgm() {
        throw new Error('load fail');
      },
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
    await expect(promise).rejects.toThrowError(/pg_trgm extension is required/);
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
      vi.doMock('@electric-sql/pglite/contrib/pg_trgm', () => ({ pg_trgm: {} }));

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
      vi.doMock('@electric-sql/pglite/contrib/pg_trgm', () => ({ pg_trgm: {} }));

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
      vi.doMock('@electric-sql/pglite/contrib/pg_trgm', () => ({ pg_trgm: {} }));

      const mod = await import('../src/wasm-loader');
      const loader = mod.wasmLoader;

      // Create a cached instance that will fail to close
      await loader.createPGlite('idb://test-error');

      // Should not throw even when close fails
      await expect(loader.disposeAll()).resolves.toBeUndefined();
    });
  });
});

describe('wasmLoader.deleteIndexedDB', () => {
  const g = globalThis as unknown as {
    window?: { indexedDB?: { deleteDatabase: (name: string) => unknown } };
  };
  const originalWindow = g.window;

  afterEach(() => {
    g.window = originalWindow;
    vi.resetModules();
  });

  function installDeleteDatabaseSpy(): { deleted: string[] } {
    const deleted: string[] = [];
    const deleteDatabase = vi.fn((name: string) => {
      deleted.push(name);
      const request: {
        onsuccess: ((event: unknown) => void) | null;
        onerror: ((event: unknown) => void) | null;
        onblocked: ((event: unknown) => void) | null;
        error: unknown;
      } = { error: null, onblocked: null, onerror: null, onsuccess: null };
      queueMicrotask(() => request.onsuccess?.(undefined));
      return request;
    });
    g.window = { indexedDB: { deleteDatabase } };
    return { deleted };
  }

  it('deletes the real /pglite/-prefixed IndexedDB database PGlite actually creates', async () => {
    // PGlite's idb backend (Emscripten IDBFS) names the database `/pglite/<name>`,
    // so deleting the bare `web-pg18` is a no-op against the real store.
    const { deleted } = installDeleteDatabaseSpy();

    const mod = await import('../src/wasm-loader');
    await mod.wasmLoader.deleteIndexedDB('idb://web-pg18');

    expect(deleted).toContain('/pglite/web-pg18');
  });

  it('also targets the bare name as a no-op safety net for non-pglite/legacy stores', async () => {
    const { deleted } = installDeleteDatabaseSpy();

    const mod = await import('../src/wasm-loader');
    await mod.wasmLoader.deleteIndexedDB('idb://app-pg18');

    expect(deleted).toContain('/pglite/app-pg18');
    expect(deleted).toContain('app-pg18');
  });

  function installBlockedDeleteDatabaseSpy(): void {
    // Fires ONLY `blocked` — another connection holds the database open and
    // never closes (the delete would complete on some later `success` we never
    // deliver in this harness).
    const deleteDatabase = vi.fn((_name: string) => {
      const request: {
        onsuccess: ((event: unknown) => void) | null;
        onerror: ((event: unknown) => void) | null;
        onblocked: ((event: unknown) => void) | null;
        error: unknown;
      } = { error: null, onblocked: null, onerror: null, onsuccess: null };
      queueMicrotask(() => request.onblocked?.(undefined));
      return request;
    });
    g.window = { indexedDB: { deleteDatabase } };
  }

  it("blockedBehavior 'resolve' settles a BLOCKED delete reporting blocked: true", async () => {
    // The first-run bootstrap recovery path relies on this: it throws its
    // "close other tabs" error directly on the reported block — without
    // settling it would hang DB initialization forever on a tab we don't
    // control, and without the report a follow-up open probe would queue
    // behind the pending delete and hang anyway.
    installBlockedDeleteDatabaseSpy();

    const mod = await import('../src/wasm-loader');
    await expect(
      mod.wasmLoader.deleteIndexedDB('idb://web-pg18', { blockedBehavior: 'resolve' })
    ).resolves.toEqual({ blocked: true });
  });

  it('reports blocked: false when the delete completes', async () => {
    installDeleteDatabaseSpy();

    const mod = await import('../src/wasm-loader');
    await expect(
      mod.wasmLoader.deleteIndexedDB('idb://web-pg18', { blockedBehavior: 'resolve' })
    ).resolves.toEqual({ blocked: false });
  });

  it("default blockedBehavior 'wait-for-close' keeps waiting on a BLOCKED delete", async () => {
    // Factory reset's contract: its own teardown closes the holding
    // connections, so the delete completes shortly — waiting is correct there.
    installBlockedDeleteDatabaseSpy();

    const mod = await import('../src/wasm-loader');
    const pending = mod.wasmLoader.deleteIndexedDB('idb://web-pg18');
    const outcome = await Promise.race([
      pending.then(() => 'settled'),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('still-waiting'), 50);
      }),
    ]);

    expect(outcome).toBe('still-waiting');
  });
});
