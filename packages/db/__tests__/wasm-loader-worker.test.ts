import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerConstructor = vi.fn();
const pgliteConstructor = vi.fn();
const pgliteWorkerCreate = vi.fn();

vi.mock('@electric-sql/pglite', () => ({
  PGlite: pgliteConstructor,
}));

vi.mock('@electric-sql/pglite/vector', () => ({
  vector: { name: 'vector-extension' },
}));

vi.mock('@electric-sql/pglite/live', () => ({
  live: { name: 'live-extension' },
}));

vi.mock('@electric-sql/pglite/worker', () => ({
  PGliteWorker: {
    create: pgliteWorkerCreate,
  },
}));

describe('wasmLoader browser worker host', () => {
  beforeEach(() => {
    vi.resetModules();
    workerConstructor.mockReset();
    pgliteConstructor.mockReset();
    pgliteWorkerCreate.mockReset();

    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: workerConstructor,
      writable: true,
    });

    pgliteConstructor.mockImplementation(function PGliteMock(this: Record<string, unknown>) {
      this.close = vi.fn().mockResolvedValue(undefined);
      this.query = vi.fn().mockResolvedValue({ rows: [] });
    });

    workerConstructor.mockImplementation(function WorkerMock(
      this: Record<string, unknown>,
      url: URL,
      options: WorkerOptions
    ) {
      this.url = url;
      this.options = options;
      this.terminate = vi.fn();
    });

    pgliteWorkerCreate.mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      live: { query: vi.fn() },
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
    });
  });

  it('creates worker-owned PGlite for browser IndexedDB paths', async () => {
    const { wasmLoader } = await import('../src/wasm-loader');

    await wasmLoader.createPGliteClient('idb://web');

    expect(pgliteConstructor).not.toHaveBeenCalled();
    expect(workerConstructor).toHaveBeenCalledWith(expect.any(URL), { type: 'module' });
    expect(pgliteWorkerCreate).toHaveBeenCalledWith(expect.any(Object), {
      dataDir: 'idb://web',
      extensions: {
        live: { name: 'live-extension' },
      },
      id: 'brainstrike-db:idb://web',
      relaxedDurability: true,
    });
  });

  it('keeps memory databases on direct PGlite for unit and integration tests', async () => {
    const { wasmLoader } = await import('../src/wasm-loader');

    await wasmLoader.createPGliteClient('memory://worker-test');

    expect(pgliteConstructor).toHaveBeenCalledTimes(1);
    expect(pgliteWorkerCreate).not.toHaveBeenCalled();
  });
});
