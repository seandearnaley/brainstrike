import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerConstructor = vi.fn();
const pgliteConstructor = vi.fn();
const pgliteWorkerCreate = vi.fn();

async function waitForMockCall(mock: typeof pgliteWorkerCreate): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (mock.mock.calls.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for mock call');
}

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

  it('deduplicates concurrent worker client creation for the same IndexedDB path', async () => {
    const workerClient = {
      close: vi.fn().mockResolvedValue(undefined),
      live: { query: vi.fn() },
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
    };
    let resolveCreate: (client: typeof workerClient) => void = () => {};
    pgliteWorkerCreate.mockImplementation(
      () =>
        new Promise<typeof workerClient>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const { wasmLoader } = await import('../src/wasm-loader');

    const first = wasmLoader.createPGliteClient('idb://web');
    const second = wasmLoader.createPGliteClient('idb://web');
    await waitForMockCall(pgliteWorkerCreate);

    expect(workerConstructor).toHaveBeenCalledTimes(1);
    expect(pgliteWorkerCreate).toHaveBeenCalledTimes(1);

    resolveCreate(workerClient);
    await expect(Promise.all([first, second])).resolves.toEqual([workerClient, workerClient]);
  });

  it('removes the pending worker promise after successful startup', async () => {
    const { wasmLoader } = await import('../src/wasm-loader');

    await wasmLoader.createPGliteClient('idb://web');

    const internals = wasmLoader as unknown as {
      workerClientPromises: Map<string, Promise<unknown>>;
    };
    expect(internals.workerClientPromises.size).toBe(0);
  });

  it('closes an in-flight worker client during disposeAll', async () => {
    const workerClient = {
      close: vi.fn().mockResolvedValue(undefined),
      live: { query: vi.fn() },
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
    };
    let resolveCreate: (client: typeof workerClient) => void = () => {};
    pgliteWorkerCreate.mockImplementation(
      () =>
        new Promise<typeof workerClient>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const { wasmLoader } = await import('../src/wasm-loader');

    const createPromise = wasmLoader.createPGliteClient('idb://web');
    const sharedPendingPromise = wasmLoader.createPGliteClient('idb://web');
    await waitForMockCall(pgliteWorkerCreate);

    let disposed = false;
    const disposePromise = wasmLoader.disposeAll().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    resolveCreate(workerClient);
    await expect(createPromise).rejects.toThrow(
      'PGlite worker client startup was disposed before completion'
    );
    await expect(sharedPendingPromise).rejects.toThrow(
      'PGlite worker client startup was disposed before completion'
    );
    await disposePromise;

    expect(workerClient.close).toHaveBeenCalledTimes(1);
  });

  it('keeps memory databases on direct PGlite for unit and integration tests', async () => {
    const { wasmLoader } = await import('../src/wasm-loader');

    await wasmLoader.createPGliteClient('memory://worker-test');

    expect(pgliteConstructor).toHaveBeenCalledTimes(1);
    expect(pgliteWorkerCreate).not.toHaveBeenCalled();
  });
});
