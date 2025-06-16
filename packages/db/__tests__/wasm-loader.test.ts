import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

let wasmLoader: typeof import('../src/wasm-loader').wasmLoader;
let PGliteMock: any;

describe('wasmLoader.ensureWasmLoaded', () => {
  beforeEach(async () => {
    // Clear all modules and reset state before each test
    vi.resetModules();
    vi.unmock('@electric-sql/pglite');
    
    vi.doMock('@electric-sql/pglite', () => {
      PGliteMock = vi.fn(() => ({
        query: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }));
      return { PGlite: PGliteMock };
    });
    
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
  });

  it('returns the same promise when called twice', async () => {
    const promise1 = wasmLoader.ensureWasmLoaded();
    const promise2 = wasmLoader.ensureWasmLoaded();
    expect(promise1).toBe(promise2);
    await promise1;
  });

  it('resets wasmLoadPromise to null after rejection', async () => {
    const error = new Error('load fail');
    PGliteMock.mockImplementation(() => ({
      query: vi.fn().mockRejectedValue(error),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    const promise = wasmLoader.ensureWasmLoaded();
    await expect(promise).rejects.toThrowError(error);
    const internal = wasmLoader as unknown as { wasmLoadPromise: Promise<void> | null };
    expect(internal.wasmLoadPromise).toBeNull();
  });
});
