import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerConstructor = vi.fn();
const pgliteConstructor = vi.fn();
const pgliteWorkerCreate = vi.fn();
const pgliteWorkerHarness = vi.fn();
interface MockWorkerInstance {
  terminate: ReturnType<typeof vi.fn>;
}

async function waitForMockCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (mock.mock.calls.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for mock call');
}

async function waitForMockCallCount(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (mock.mock.calls.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${count} mock calls`);
}

vi.mock('@electric-sql/pglite', () => ({
  PGlite: pgliteConstructor,
}));

vi.mock('@electric-sql/pglite-pgvector', () => ({
  vector: { name: 'vector-extension' },
}));

vi.mock('@electric-sql/pglite/live', () => ({
  live: { name: 'live-extension' },
}));

vi.mock('@electric-sql/pglite/contrib/pg_trgm', () => ({
  pg_trgm: { name: 'pg-trgm-extension' },
}));

vi.mock('@electric-sql/pglite/worker', () => ({
  worker: pgliteWorkerHarness,
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
    pgliteWorkerHarness.mockReset();

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
      exec: vi.fn().mockResolvedValue(undefined),
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
      relaxedDurability: false,
    });
  });

  it('creates worker-owned PGlite for browser OPFS AHP paths', async () => {
    const { wasmLoader } = await import('../src/wasm-loader');

    await wasmLoader.createPGliteClient('opfs-ahp://web');

    expect(pgliteConstructor).not.toHaveBeenCalled();
    expect(workerConstructor).toHaveBeenCalledWith(expect.any(URL), { type: 'module' });
    expect(pgliteWorkerCreate).toHaveBeenCalledWith(expect.any(Object), {
      dataDir: 'opfs-ahp://web',
      extensions: {
        live: { name: 'live-extension' },
      },
      id: 'brainstrike-db:opfs-ahp://web',
      relaxedDurability: false,
    });
  });

  it('rejects direct browser PGlite construction for OPFS AHP paths', async () => {
    const { wasmLoader } = await import('../src/wasm-loader');

    await expect(wasmLoader.createPGlite('opfs-ahp://web')).rejects.toThrow(
      'Browser OPFS AHP PGlite requires the PGlite worker host'
    );

    expect(pgliteConstructor).not.toHaveBeenCalled();
  });

  it('returns a worker client that satisfies the shared DB execution contract', async () => {
    const { getMissingBrainstrikeDbClientCapabilities, wasmLoader } = await import(
      '../src/index.js'
    );

    const client = await wasmLoader.createPGliteClient('idb://web');

    expect(getMissingBrainstrikeDbClientCapabilities(client)).toEqual([]);
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
      workerClientStartups: Map<string, unknown>;
    };
    expect(internals.workerClientStartups.size).toBe(0);
  });

  it('terminates an in-flight worker startup during disposeAll', async () => {
    const workerClient = {
      close: vi.fn().mockResolvedValue(undefined),
      live: { query: vi.fn() },
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
    };
    pgliteWorkerCreate.mockImplementation(() => new Promise<typeof workerClient>(() => undefined));
    const { wasmLoader } = await import('../src/wasm-loader');

    const createPromise = wasmLoader.createPGliteClient('idb://web');
    const sharedPendingPromise = wasmLoader.createPGliteClient('idb://web');
    await waitForMockCall(pgliteWorkerCreate);

    await expect(wasmLoader.disposeAll()).resolves.toBeUndefined();

    await expect(createPromise).rejects.toThrow(
      'PGlite worker client startup was disposed before completion'
    );
    await expect(sharedPendingPromise).rejects.toThrow(
      'PGlite worker client startup was disposed before completion'
    );

    const workerInstance = workerConstructor.mock.instances[0] as MockWorkerInstance;
    expect(workerInstance.terminate).toHaveBeenCalledTimes(1);
    expect(workerClient.close).not.toHaveBeenCalled();
  });

  it('terminates an unresolved worker startup before creating a replacement client', async () => {
    const firstWorkerClient = {
      close: vi.fn().mockResolvedValue(undefined),
      live: { query: vi.fn() },
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
    };
    const secondWorkerClient = {
      close: vi.fn().mockResolvedValue(undefined),
      live: { query: vi.fn() },
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
    };
    const resolveCreateCalls: Array<(client: typeof firstWorkerClient) => void> = [];
    pgliteWorkerCreate.mockImplementation(
      () =>
        new Promise<typeof firstWorkerClient>((resolve) => {
          resolveCreateCalls.push(resolve);
        })
    );
    const { wasmLoader } = await import('../src/wasm-loader');

    const firstCreatePromise = wasmLoader.createPGliteClient('idb://web');
    await waitForMockCall(pgliteWorkerCreate);

    await expect(wasmLoader.closeCached('idb://web')).resolves.toBeUndefined();
    const internals = wasmLoader as unknown as {
      workerClientStartups: Map<string, unknown>;
    };
    expect(internals.workerClientStartups.has('idb://web')).toBe(false);
    const firstWorkerInstance = workerConstructor.mock.instances[0] as MockWorkerInstance;
    expect(firstWorkerInstance.terminate).toHaveBeenCalledTimes(1);
    await expect(firstCreatePromise).rejects.toThrow(
      'PGlite worker client startup was disposed before completion'
    );

    const secondCreatePromise = wasmLoader.createPGliteClient('idb://web');
    await Promise.resolve();

    await waitForMockCallCount(pgliteWorkerCreate, 2);
    expect(pgliteWorkerCreate).toHaveBeenCalledTimes(2);
    resolveCreateCalls[1]?.(secondWorkerClient);
    await expect(secondCreatePromise).resolves.toBe(secondWorkerClient);
    expect(firstWorkerClient.close).not.toHaveBeenCalled();
  });

  it('closes a late-resolved disposed worker startup once', async () => {
    const workerClient = {
      close: vi.fn().mockResolvedValue(undefined),
      live: { query: vi.fn() },
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
    };
    let resolveCreate: (client: typeof workerClient) => void = () => undefined;
    pgliteWorkerCreate.mockImplementation(
      () =>
        new Promise<typeof workerClient>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const { wasmLoader } = await import('../src/wasm-loader');

    const createPromise = wasmLoader.createPGliteClient('idb://web');
    await waitForMockCall(pgliteWorkerCreate);

    resolveCreate(workerClient);
    await expect(wasmLoader.closeCached('idb://web')).resolves.toBeUndefined();
    await expect(createPromise).rejects.toThrow(
      'PGlite worker client startup was disposed before completion'
    );

    expect(workerClient.close).toHaveBeenCalledTimes(1);
  });

  it('keeps memory databases on direct PGlite for unit and integration tests', async () => {
    const { wasmLoader } = await import('../src/wasm-loader');

    await wasmLoader.createPGliteClient('memory://worker-test');

    expect(pgliteConstructor).toHaveBeenCalledTimes(1);
    expect(pgliteWorkerCreate).not.toHaveBeenCalled();
  });

  it('creates a process.env shim before worker init constructs browser PGlite', async () => {
    const originalProcessDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    interface WorkerHarnessConfig {
      init: (options: unknown) => Promise<unknown>;
    }
    let capturedConfig: WorkerHarnessConfig | null = null;
    pgliteWorkerHarness.mockImplementation((config: WorkerHarnessConfig) => {
      capturedConfig = config;
    });
    pgliteConstructor.mockImplementation(function PGliteMock(this: Record<string, unknown>) {
      const runtimeProcess = (globalThis as { process?: { env?: Record<string, string> } }).process;
      if (!runtimeProcess?.env) {
        throw new Error('process.env missing before PGlite construction');
      }
      this.close = vi.fn().mockResolvedValue(undefined);
      this.query = vi.fn().mockResolvedValue({ rows: [] });
    });

    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    try {
      await import('../src/pglite-worker-entry');
      await waitForMockCall(pgliteWorkerHarness);

      expect(capturedConfig).not.toBeNull();
      await expect(
        capturedConfig?.init({ dataDir: 'idb://web', relaxedDurability: false })
      ).resolves.toBeDefined();
      expect(pgliteConstructor).toHaveBeenCalledWith({
        dataDir: 'idb://web',
        extensions: {
          pg_trgm: { name: 'pg-trgm-extension' },
          vector: { name: 'vector-extension' },
        },
        relaxedDurability: false,
      });
      expect(
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
          ?.NODE_ENV
      ).toBe('test');
    } finally {
      if (originalProcessDescriptor) {
        Object.defineProperty(globalThis, 'process', originalProcessDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'process');
      }
    }
  });
});
