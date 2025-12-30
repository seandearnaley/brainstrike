import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let wasmLoader: typeof import('../src/wasm-loader').wasmLoader;
let PGliteMock: ReturnType<typeof vi.fn>;

describe('wasmLoader.ensureWasmLoaded', () => {
  beforeEach(async () => {
    // Clear all modules and reset state before each test
    vi.resetModules();
    vi.unmock('@electric-sql/pglite');
    vi.unmock('@electric-sql/pglite/vector');

    vi.doMock('@electric-sql/pglite', () => {
      PGliteMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.query = vi.fn().mockResolvedValue(undefined);
        this.close = vi.fn().mockResolvedValue(undefined);
      });
      return { PGlite: PGliteMock };
    });

    // Mock the vector extension
    vi.doMock('@electric-sql/pglite/vector', () => ({
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
    vi.unmock('@electric-sql/pglite/vector');
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
    vi.doMock('@electric-sql/pglite/vector', () => ({
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
});
