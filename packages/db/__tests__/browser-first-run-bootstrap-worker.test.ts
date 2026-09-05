/**
 * Dedicated bootstrap worker: message protocol (strict parse, single-run,
 * ok/error results) and the PGlite factory option pinning that carries the
 * durability contract — the store-load instance MUST be strict
 * (`relaxedDurability: false`, #1111) with the full engine-extension set
 * (PGLITE EXTENSION INVARIANT).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgliteConstructor } = vi.hoisted(() => ({ pgliteConstructor: vi.fn() }));

vi.mock('@electric-sql/pglite', () => ({
  PGlite: { create: (options: unknown) => Promise.resolve(new pgliteConstructor(options)) },
}));

vi.mock('@electric-sql/pglite/contrib/pg_trgm', () => ({
  pg_trgm: { name: 'pg-trgm-extension' },
}));

vi.mock('@electric-sql/pglite-pgvector', () => ({
  vector: { name: 'vector-extension' },
}));

vi.mock('@electric-sql/pglite-pg_textsearch', () => ({
  pg_textsearch: { name: 'pg-textsearch-extension' },
}));

import {
  type FirstRunBootstrapResultMessage,
  firstRunBootstrapWorkerPGliteFactories,
  initializeFirstRunBootstrapWorker,
} from '../src/browser-first-run-bootstrap-worker.js';

interface FakeScope {
  emit(data: unknown): void;
  readonly posted: FirstRunBootstrapResultMessage[];
  readonly scope: Parameters<typeof initializeFirstRunBootstrapWorker>[0];
  waitForResult(count?: number): Promise<void>;
}

function createFakeScope(): FakeScope {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const posted: FirstRunBootstrapResultMessage[] = [];
  return {
    emit: (data: unknown) => {
      for (const listener of listeners) {
        listener({ data } as MessageEvent);
      }
    },
    posted,
    scope: {
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
      postMessage: (message) => {
        posted.push(message);
      },
    },
    waitForResult: async (count = 1) => {
      for (let index = 0; index < 50; index += 1) {
        if (posted.length >= count) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error('Timed out waiting for worker result');
    },
  };
}

function createStubFactories() {
  const calls: string[] = [];
  const dump = new Blob(['dump']);
  return {
    calls,
    dump,
    factories: {
      createMemoryDb: vi.fn(async () => {
        calls.push('createMemoryDb');
        return {
          close: vi.fn(async () => undefined),
          dumpDataDir: vi.fn(async () => dump),
          syncToFs: vi.fn(async () => undefined),
        };
      }),
      createStoreLoadDb: vi.fn(async (_dataDir: string, _dump: Blob | File) => {
        calls.push('createStoreLoadDb');
        return {
          close: vi.fn(async () => undefined),
          dumpDataDir: vi.fn(async () => new Blob([])),
          syncToFs: vi.fn(async () => {
            calls.push('store.syncToFs');
          }),
        };
      }),
    },
  };
}

describe('initializeFirstRunBootstrapWorker', () => {
  it('runs the pipeline for a valid run message and posts ok', async () => {
    const fake = createFakeScope();
    const stub = createStubFactories();
    initializeFirstRunBootstrapWorker(fake.scope, {
      ...stub.factories,
      // Test seam: skip the real migration suite in this protocol-level test.
      migrateDatabase: async () => {
        stub.calls.push('migrateDatabase');
      },
    });

    fake.emit({ dataDir: 'idb://worker-unit', type: 'run' });
    await fake.waitForResult();

    expect(fake.posted).toEqual([{ ok: true, type: 'result' }]);
    expect(stub.calls).toEqual([
      'createMemoryDb',
      'migrateDatabase',
      'createStoreLoadDb',
      'store.syncToFs',
    ]);
    expect(stub.factories.createStoreLoadDb).toHaveBeenCalledWith('idb://worker-unit', stub.dump);
  });

  it('rejects malformed messages with a failed result and never runs PGlite', async () => {
    const fake = createFakeScope();
    const stub = createStubFactories();
    initializeFirstRunBootstrapWorker(fake.scope, stub.factories);

    fake.emit({ dataDir: 'memory://nope', type: 'run' });
    await fake.waitForResult();

    expect(fake.posted[0]).toEqual({
      error: expect.stringContaining('dataDir must be an idb:// string'),
      ok: false,
      type: 'result',
    });
    expect(stub.factories.createMemoryDb).not.toHaveBeenCalled();
  });

  it('rejects a second run message', async () => {
    const fake = createFakeScope();
    const stub = createStubFactories();
    initializeFirstRunBootstrapWorker(fake.scope, stub.factories);

    fake.emit({ dataDir: 'memory://invalid-so-it-fails-fast', type: 'run' });
    fake.emit({ dataDir: 'idb://second', type: 'run' });
    await fake.waitForResult(2);

    expect(fake.posted[1]).toEqual({
      error: 'First-run bootstrap worker accepts a single run message',
      ok: false,
      type: 'result',
    });
  });

  it('reports pipeline failures as a failed result with the error detail', async () => {
    const fake = createFakeScope();
    const stub = createStubFactories();
    initializeFirstRunBootstrapWorker(fake.scope, {
      ...stub.factories,
      createMemoryDb: async () => {
        throw new Error('wasm fetch failed');
      },
    });

    fake.emit({ dataDir: 'idb://worker-unit', type: 'run' });
    await fake.waitForResult();

    expect(fake.posted[0]).toEqual({
      error: expect.stringContaining('wasm fetch failed'),
      ok: false,
      type: 'result',
    });
  });
});

describe('firstRunBootstrapWorkerPGliteFactories', () => {
  beforeEach(() => {
    pgliteConstructor.mockReset();
    pgliteConstructor.mockImplementation(function PGliteMock(this: Record<string, unknown>) {
      this.waitReady = Promise.resolve();
    });
  });

  it('creates the memory database with the full engine-extension set', async () => {
    await firstRunBootstrapWorkerPGliteFactories.createMemoryDb();

    expect(pgliteConstructor).toHaveBeenCalledWith({
      extensions: {
        pg_textsearch: { name: 'pg-textsearch-extension' },
        pg_trgm: { name: 'pg-trgm-extension' },
        vector: { name: 'vector-extension' },
      },
    });
  });

  it('creates the store-load database STRICT with the dump passed through', async () => {
    const dump = new Blob(['migrated-datadir']);

    await firstRunBootstrapWorkerPGliteFactories.createStoreLoadDb('idb://web-pg18', dump);

    expect(pgliteConstructor).toHaveBeenCalledWith({
      dataDir: 'idb://web-pg18',
      extensions: {
        pg_textsearch: { name: 'pg-textsearch-extension' },
        pg_trgm: { name: 'pg-trgm-extension' },
        vector: { name: 'vector-extension' },
      },
      loadDataDir: dump,
      // The persistent store is only ever written by STRICT instances (#1111).
      relaxedDurability: false,
    });
  });
});
