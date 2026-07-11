/**
 * First-run fast bootstrap — orchestration unit tests (stubbed bootstrap).
 *
 * The real-engine dump/load proof lives in
 * browser-first-run-bootstrap.integration.test.ts and the pipeline ordering in
 * browser-first-run-bootstrap-pipeline.test.ts; these tests pin the
 * orchestration contract: capability gates, existence probing, marker
 * lifecycle, torn-store recovery, and error propagation (never a silent
 * fallback).
 */

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserIndexedDbDatabaseExists,
  type FirstRunBootstrapDependencies,
  firstRunBootstrapIdbDatabaseName,
  firstRunBootstrapMarkerKey,
  maybeBootstrapBrowserFirstRunStore,
} from '../src/browser-first-run-bootstrap.js';

const DATA_DIR = 'idb://bootstrap-unit';
const IDB_NAME = firstRunBootstrapIdbDatabaseName(DATA_DIR);

let idbFactory: IDBFactory;
const globalDescriptors = new Map<string, PropertyDescriptor | undefined>();

function installGlobal(name: string, value: unknown): void {
  if (!globalDescriptors.has(name)) {
    globalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
}

function restoreGlobals(): void {
  for (const [name, descriptor] of globalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  }
  globalDescriptors.clear();
}

interface LocksStub {
  readonly request: (
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<void>
  ) => Promise<void>;
}

function installWebLocksStub(): void {
  const queues = new Map<string, Promise<void>>();
  const locks: LocksStub = {
    request: (name, _options, callback) => {
      const previous = queues.get(name) ?? Promise.resolve();
      const next = previous.then(() => callback());
      queues.set(
        name,
        next.catch(() => undefined)
      );
      return next;
    },
  };
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: locks,
    writable: true,
  });
}

function removeWebLocks(): void {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

function createIdbDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = idbFactory.open(name);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

function deleteIdbDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = idbFactory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('delete failed'));
  });
}

interface StubHarness {
  readonly bootstrapStore: ReturnType<typeof vi.fn>;
  readonly deleteStore: ReturnType<typeof vi.fn>;
  readonly deps: FirstRunBootstrapDependencies;
}

function createStubHarness(
  options: { bootstrapImpl?: (dataDir: string) => Promise<void> } = {}
): StubHarness {
  const bootstrapStore = vi.fn(async (dataDir: string) => {
    if (options.bootstrapImpl) {
      await options.bootstrapImpl(dataDir);
      return;
    }
    // The real strict flush is what makes the store exist durably; the stub
    // mirrors that observable effect.
    await createIdbDatabase(firstRunBootstrapIdbDatabaseName(dataDir));
  });
  const deleteStore = vi.fn(async (dataDir: string) => {
    await deleteIdbDatabase(firstRunBootstrapIdbDatabaseName(dataDir));
  });
  return {
    bootstrapStore,
    deleteStore,
    deps: {
      bootstrapStore: bootstrapStore as unknown as (dataDir: string) => Promise<void>,
      deleteStore: deleteStore as unknown as (dataDir: string) => Promise<void>,
    },
  };
}

describe('maybeBootstrapBrowserFirstRunStore', () => {
  beforeEach(() => {
    idbFactory = new IDBFactory();
    installGlobal('indexedDB', idbFactory);
    installWebLocksStub();
    localStorage.clear();
  });

  afterEach(() => {
    restoreGlobals();
    removeWebLocks();
    localStorage.clear();
  });

  it('skips non-IndexedDB data dirs without touching anything', async () => {
    const harness = createStubHarness();
    await expect(
      maybeBootstrapBrowserFirstRunStore('opfs-ahp://web-pg18', harness.deps)
    ).resolves.toEqual({ performed: false, reason: 'not-indexeddb-data-dir' });
    await expect(maybeBootstrapBrowserFirstRunStore('memory://', harness.deps)).resolves.toEqual({
      performed: false,
      reason: 'not-indexeddb-data-dir',
    });
    expect(harness.bootstrapStore).not.toHaveBeenCalled();
  });

  it('skips when IndexedDB is unavailable', async () => {
    installGlobal('indexedDB', undefined);
    const harness = createStubHarness();
    await expect(maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps)).resolves.toEqual({
      performed: false,
      reason: 'indexeddb-unavailable',
    });
    expect(harness.bootstrapStore).not.toHaveBeenCalled();
  });

  it('skips when Web Locks are unavailable', async () => {
    removeWebLocks();
    const harness = createStubHarness();
    await expect(maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps)).resolves.toEqual({
      performed: false,
      reason: 'web-locks-unavailable',
    });
    expect(harness.bootstrapStore).not.toHaveBeenCalled();
  });

  it('skips when marker storage is unusable', async () => {
    const throwingStorage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error('quota');
      },
    };
    installGlobal('localStorage', throwingStorage);
    const harness = createStubHarness();
    await expect(maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps)).resolves.toEqual({
      performed: false,
      reason: 'marker-storage-unavailable',
    });
    expect(harness.bootstrapStore).not.toHaveBeenCalled();
  });

  it('skips an existing store without touching the marker or the bootstrap', async () => {
    await createIdbDatabase(IDB_NAME);
    const harness = createStubHarness();
    await expect(maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps)).resolves.toEqual({
      performed: false,
      reason: 'existing-store',
    });
    expect(harness.bootstrapStore).not.toHaveBeenCalled();
    expect(harness.deleteStore).not.toHaveBeenCalled();
    expect(localStorage.getItem(firstRunBootstrapMarkerKey(DATA_DIR))).toBeNull();
  });

  it('bootstraps a missing store with the marker bracketing the run', async () => {
    const harness = createStubHarness();

    const result = await maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps);

    expect(result).toEqual({ performed: true, recoveredPartialBootstrap: false });
    expect(harness.bootstrapStore).toHaveBeenCalledExactlyOnceWith(DATA_DIR);
    expect(harness.deleteStore).not.toHaveBeenCalled();
    // Marker cleared only after the flush created the store.
    expect(localStorage.getItem(firstRunBootstrapMarkerKey(DATA_DIR))).toBeNull();
    await expect(browserIndexedDbDatabaseExists(IDB_NAME)).resolves.toBe(true);
  });

  it('recovers a partial bootstrap: deletes the torn store and re-runs greenfield', async () => {
    await createIdbDatabase(IDB_NAME);
    localStorage.setItem(firstRunBootstrapMarkerKey(DATA_DIR), '2026-07-10T00:00:00.000Z');
    const harness = createStubHarness();

    const result = await maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps);

    expect(result).toEqual({ performed: true, recoveredPartialBootstrap: true });
    expect(harness.deleteStore).toHaveBeenCalledExactlyOnceWith(DATA_DIR);
    expect(harness.bootstrapStore).toHaveBeenCalledExactlyOnceWith(DATA_DIR);
    expect(localStorage.getItem(firstRunBootstrapMarkerKey(DATA_DIR))).toBeNull();
  });

  it('fails loudly when the partial store cannot be deleted', async () => {
    await createIdbDatabase(IDB_NAME);
    localStorage.setItem(firstRunBootstrapMarkerKey(DATA_DIR), '2026-07-10T00:00:00.000Z');
    const harness = createStubHarness();
    const deps: FirstRunBootstrapDependencies = {
      bootstrapStore: harness.deps.bootstrapStore,
      deleteStore: vi.fn(async () => undefined), // resolves without deleting (blocked)
    };

    await expect(maybeBootstrapBrowserFirstRunStore(DATA_DIR, deps)).rejects.toThrow(
      /Cannot reclaim the partial first-run PGlite store/
    );
    expect(harness.bootstrapStore).not.toHaveBeenCalled();
    // Marker intentionally survives so the next launch retries recovery.
    expect(localStorage.getItem(firstRunBootstrapMarkerKey(DATA_DIR))).not.toBeNull();
  });

  it('propagates a bootstrap failure and leaves the marker set', async () => {
    const harness = createStubHarness({
      bootstrapImpl: () => Promise.reject(new Error('bootstrap exploded')),
    });

    await expect(maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps)).rejects.toThrow(
      'bootstrap exploded'
    );

    // Marker survives → next launch reclaims the partial store.
    expect(localStorage.getItem(firstRunBootstrapMarkerKey(DATA_DIR))).not.toBeNull();
  });

  it('fails loudly when the bootstrap resolves but the store is still absent', async () => {
    const harness = createStubHarness({ bootstrapImpl: async () => undefined });

    await expect(maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps)).rejects.toThrow(
      /flushed successfully but the IndexedDB store .* is absent/
    );
    expect(localStorage.getItem(firstRunBootstrapMarkerKey(DATA_DIR))).not.toBeNull();
  });

  it('serializes concurrent callers: the second sees the existing store', async () => {
    const harness = createStubHarness();

    const [first, second] = await Promise.all([
      maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps),
      maybeBootstrapBrowserFirstRunStore(DATA_DIR, harness.deps),
    ]);

    expect(first).toEqual({ performed: true, recoveredPartialBootstrap: false });
    expect(second).toEqual({ performed: false, reason: 'existing-store' });
    expect(harness.bootstrapStore).toHaveBeenCalledTimes(1);
  });
});

describe('browserIndexedDbDatabaseExists', () => {
  beforeEach(() => {
    idbFactory = new IDBFactory();
    installGlobal('indexedDB', idbFactory);
  });

  afterEach(() => {
    restoreGlobals();
  });

  it('reports existence via databases() enumeration', async () => {
    await createIdbDatabase('/pglite/probe-enum');
    await expect(browserIndexedDbDatabaseExists('/pglite/probe-enum')).resolves.toBe(true);
    await expect(browserIndexedDbDatabaseExists('/pglite/probe-missing')).resolves.toBe(false);
  });

  it('falls back to an abort-on-upgrade open probe without creating the database', async () => {
    await createIdbDatabase('/pglite/probe-open');
    // Simulate an enumeration-incapable engine (older Safari/Firefox).
    const noEnumFactory = {
      deleteDatabase: idbFactory.deleteDatabase.bind(idbFactory),
      open: idbFactory.open.bind(idbFactory),
    };
    installGlobal('indexedDB', noEnumFactory);

    await expect(browserIndexedDbDatabaseExists('/pglite/probe-open')).resolves.toBe(true);
    await expect(browserIndexedDbDatabaseExists('/pglite/probe-absent')).resolves.toBe(false);

    // The probe must not have materialized the absent database.
    const names = (await idbFactory.databases()).map((info) => info.name);
    expect(names).toContain('/pglite/probe-open');
    expect(names).not.toContain('/pglite/probe-absent');
  });
});
