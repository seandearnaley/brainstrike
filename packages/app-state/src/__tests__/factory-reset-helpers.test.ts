import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClearPersistentUiStateResult } from '../factory-reset';
import {
  clearPersistentUiState,
  clearPersistentUiStateWithResult,
  FALLBACK_INDEXED_DB_NAMES,
  prepareFactoryReset,
  registerFactoryResetPreparation,
  registerFactoryResetSessionStore,
} from '../factory-reset';

interface FakeRequest {
  error?: DOMException | null;
  onblocked: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onsuccess: ((event: Event) => void) | null;
}

const globalWindow = window as Window &
  typeof globalThis & {
    indexedDB?: IDBFactory;
    caches?: CacheStorage;
  };

describe('factory reset preparation', () => {
  it('starts every owner and joins their admitted work before returning', async () => {
    const pending = Promise.withResolvers<void>();
    const otherOwner = vi.fn(async () => {});
    const removeFirst = registerFactoryResetPreparation(() => pending.promise);
    const removeOther = registerFactoryResetPreparation(otherOwner);
    let prepared = false;
    const preparation = prepareFactoryReset().then(() => {
      prepared = true;
    });
    try {
      expect(otherOwner).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(prepared).toBe(false);
      pending.resolve();
      await preparation;
      expect(prepared).toBe(true);
    } finally {
      pending.resolve();
      removeFirst();
      removeOther();
    }
  });

  it('retains every preparation failure and removes disposed registrations', async () => {
    const first = new Error('workspace save failed');
    const second = new Error('another owner failed');
    const removeFirst = registerFactoryResetPreparation(async () => {
      throw first;
    });
    const removeSecond = registerFactoryResetPreparation(async () => {
      throw second;
    });
    try {
      await expect(prepareFactoryReset()).rejects.toMatchObject({ errors: [first, second] });
    } finally {
      removeFirst();
      removeSecond();
    }
    await expect(prepareFactoryReset()).resolves.toBeUndefined();
  });
});

describe('registerFactoryResetSessionStore', () => {
  it('drains registered session-store resetters during a factory reset', async () => {
    const reset = vi.fn();
    const dispose = registerFactoryResetSessionStore(reset);
    try {
      await clearPersistentUiStateWithResult({ skipIndexedDb: true });
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('stops draining a resetter once it is disposed', async () => {
    const reset = vi.fn();
    const dispose = registerFactoryResetSessionStore(reset);
    dispose();
    await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    expect(reset).not.toHaveBeenCalled();
  });

  it('a throwing resetter does not abort the reset', async () => {
    const dispose = registerFactoryResetSessionStore(() => {
      throw new Error('boom');
    });
    try {
      const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
      expect(result.success).toBe(true);
    } finally {
      dispose();
    }
  });
});

describe('FALLBACK_INDEXED_DB_NAMES engine versioning', () => {
  it('includes the PG18 engine-versioned database names so Safari/Firefox fallback wipes them', () => {
    // The persistent browser data dirs were versioned to idb://app-pg18 / idb://web-pg18
    // when PGlite upgraded to Postgres 18. The fallback wipe list (used when
    // indexedDB.databases() is unavailable) must target the versioned names.
    expect(FALLBACK_INDEXED_DB_NAMES).toContain('app-pg18');
    expect(FALLBACK_INDEXED_DB_NAMES).toContain('web-pg18');
  });

  it('retains the legacy unversioned names to clean up stale PG17 installs', () => {
    expect(FALLBACK_INDEXED_DB_NAMES).toContain('app');
    expect(FALLBACK_INDEXED_DB_NAMES).toContain('web');
  });

  it('targets the real /pglite/-prefixed IndexedDB names PGlite actually creates', () => {
    // PGlite's idb backend (Emscripten IDBFS) names the IndexedDB database
    // `/pglite/<dataDir>`, NOT the bare data-dir name — so a fallback list of bare
    // names matches nothing against pglite stores. The list must include the
    // prefixed names for the non-enumerating (Safari/Firefox) wipe to work.
    expect(FALLBACK_INDEXED_DB_NAMES).toContain('/pglite/app-pg18');
    expect(FALLBACK_INDEXED_DB_NAMES).toContain('/pglite/web-pg18');
    expect(FALLBACK_INDEXED_DB_NAMES).toContain('/pglite/app');
    expect(FALLBACK_INDEXED_DB_NAMES).toContain('/pglite/web');
  });
});

function createDeleteDatabaseMock() {
  return vi.fn((_name: string) => {
    const request: FakeRequest = {
      onblocked: null,
      onerror: null,
      onsuccess: null,
    };

    queueMicrotask(() => {
      request.onsuccess?.(new Event('success'));
    });

    return request as unknown as IDBOpenDBRequest;
  });
}

describe('clearPersistentUiState IndexedDB handling', () => {
  let originalIndexedDB: IDBFactory | undefined;
  let originalCaches: CacheStorage | undefined;
  let deleteDatabaseMock: ReturnType<typeof createDeleteDatabaseMock>;
  let cachesMock: CacheStorage;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalIndexedDB = globalWindow.indexedDB;
    originalCaches = globalWindow.caches;

    deleteDatabaseMock = createDeleteDatabaseMock();
    cachesMock = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
    } as unknown as CacheStorage;

    Object.defineProperty(globalWindow, 'indexedDB', {
      configurable: true,
      value: {
        deleteDatabase: deleteDatabaseMock,
      } as unknown as IDBFactory,
    });

    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: cachesMock,
    });
  });

  afterEach(() => {
    if (originalIndexedDB) {
      Object.defineProperty(globalWindow, 'indexedDB', {
        configurable: true,
        value: originalIndexedDB,
      });
    } else {
      Reflect.deleteProperty(globalWindow, 'indexedDB');
    }

    if (originalCaches) {
      Object.defineProperty(globalWindow, 'caches', {
        configurable: true,
        value: originalCaches,
      });
    } else {
      Reflect.deleteProperty(globalWindow, 'caches');
    }
  });

  it('falls back to known databases when IndexedDB enumeration is unavailable', async () => {
    await clearPersistentUiState();

    expect(deleteDatabaseMock).toHaveBeenCalledTimes(FALLBACK_INDEXED_DB_NAMES.length);
    const deletedNames = deleteDatabaseMock.mock.calls.map(([name]) => name);
    expect(deletedNames).toEqual(expect.arrayContaining([...FALLBACK_INDEXED_DB_NAMES]));
  });

  it('uses fallback names when enumeration throws', async () => {
    const databasesMock = vi.fn(async () => {
      throw new Error('no enumeration');
    });
    Object.defineProperty(globalWindow, 'indexedDB', {
      configurable: true,
      value: {
        databases: databasesMock,
        deleteDatabase: deleteDatabaseMock,
      } as unknown as IDBFactory,
    });

    await clearPersistentUiState();

    expect(databasesMock).toHaveBeenCalled();
    expect(deleteDatabaseMock).toHaveBeenCalledTimes(FALLBACK_INDEXED_DB_NAMES.length);
  });

  it('deletes enumerated databases when available', async () => {
    const databasesMock = vi.fn(async () => [{ name: 'custom-db' }]);
    Object.defineProperty(globalWindow, 'indexedDB', {
      configurable: true,
      value: {
        databases: databasesMock,
        deleteDatabase: deleteDatabaseMock,
      } as unknown as IDBFactory,
    });

    await clearPersistentUiState();

    expect(databasesMock).toHaveBeenCalled();
    expect(deleteDatabaseMock).toHaveBeenCalledTimes(1);
    expect(deleteDatabaseMock).toHaveBeenCalledWith('custom-db');
  });

  it('skips IndexedDB clearing when requested', async () => {
    await clearPersistentUiState({ skipIndexedDb: true });

    expect(deleteDatabaseMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      event: 'error' as const,
      expectedMessage: 'delete failed',
      failure: new DOMException('delete failed', 'UnknownError'),
    },
    {
      event: 'blocked' as const,
      expectedMessage: 'blocked',
      failure: null,
    },
  ])(
    'reports an incomplete reset when IndexedDB deletion emits $event',
    async ({ event, expectedMessage, failure }) => {
      deleteDatabaseMock.mockImplementationOnce(() => {
        const request: FakeRequest = {
          error: failure,
          onblocked: null,
          onerror: null,
          onsuccess: null,
        };
        queueMicrotask(() => {
          if (event === 'error') {
            request.onerror?.(new Event('error'));
          } else {
            request.onblocked?.(new Event('blocked'));
          }
        });
        return request as unknown as IDBOpenDBRequest;
      });

      const result = await clearPersistentUiStateWithResult();

      expect(result.success).toBe(false);
      expect(result.failures).toEqual([
        expect.objectContaining({
          name: FALLBACK_INDEXED_DB_NAMES[0],
          operation: 'delete',
          target: 'indexed-db',
        }),
      ]);
      expect(String(result.failures[0]?.error)).toContain(expectedMessage);
    }
  );

  it('reports an incomplete reset when IndexedDB deletion throws synchronously', async () => {
    const deletionFailure = new Error('IndexedDB bridge crashed');
    deleteDatabaseMock.mockImplementation(() => {
      throw deletionFailure;
    });

    const result = await clearPersistentUiStateWithResult();

    expect(result.success).toBe(false);
    expect(result.failures).toHaveLength(FALLBACK_INDEXED_DB_NAMES.length);
    expect(result.failures[0]).toMatchObject({
      error: deletionFailure,
      name: FALLBACK_INDEXED_DB_NAMES[0],
      operation: 'delete',
      target: 'indexed-db',
    });
    await expect(clearPersistentUiState()).rejects.toThrow('IndexedDB bridge crashed');
  });

  it('clears browser storage and Electron renderer stores during reset', async () => {
    const localStorageClear = vi.spyOn(Storage.prototype, 'clear');
    const rendererStorageClear = vi.fn(async () => undefined);
    const secretsClearAll = vi.fn(async () => ({ success: true }));
    const settingsClearAll = vi.fn(async () => undefined);

    Object.defineProperty(globalWindow, 'electronAPI', {
      configurable: true,
      value: { storage: { clear: rendererStorageClear } },
    });
    Object.defineProperty(globalWindow, 'secrets', {
      configurable: true,
      value: { clearAll: secretsClearAll },
    });
    Object.defineProperty(globalWindow, 'settings', {
      configurable: true,
      value: { clearAll: settingsClearAll },
    });

    try {
      await clearPersistentUiState({ skipIndexedDb: true });
    } finally {
      Reflect.deleteProperty(globalWindow, 'electronAPI');
      Reflect.deleteProperty(globalWindow, 'secrets');
      Reflect.deleteProperty(globalWindow, 'settings');
    }

    expect(localStorageClear).toHaveBeenCalledTimes(2);
    expect(rendererStorageClear).toHaveBeenCalledTimes(1);
    expect(secretsClearAll).toHaveBeenCalledWith('CONFIRM_CLEAR_SECRETS');
    expect(settingsClearAll).toHaveBeenCalledTimes(1);
  });

  it('aggregates Electron bridge failures, including a fulfilled secrets rejection', async () => {
    const rendererStorageClear = vi.fn(async () => {
      throw new Error('renderer storage is locked');
    });
    const secretsClearAll = vi.fn(async () => ({
      message: 'OS keychain refused deletion',
      success: false,
    }));
    const settingsClearAll = vi.fn(async () => {
      throw new Error('settings store is locked');
    });
    Object.defineProperty(globalWindow, 'electronAPI', {
      configurable: true,
      value: { storage: { clear: rendererStorageClear } },
    });
    Object.defineProperty(globalWindow, 'secrets', {
      configurable: true,
      value: { clearAll: secretsClearAll },
    });
    Object.defineProperty(globalWindow, 'settings', {
      configurable: true,
      value: { clearAll: settingsClearAll },
    });

    try {
      const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });

      expect(result.success).toBe(false);
      expect(result.failures.map((failure) => failure.target)).toEqual([
        'electron-renderer-storage',
        'electron-secrets',
        'electron-settings',
      ]);
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: 'clear', target: 'electron-secrets' }),
        ])
      );
      expect(
        result.failures.find((failure) => failure.target === 'electron-secrets')?.error
      ).toMatchObject({ message: 'OS keychain refused deletion' });
      expect(rendererStorageClear).toHaveBeenCalledTimes(1);
      expect(secretsClearAll).toHaveBeenCalledTimes(1);
      expect(settingsClearAll).toHaveBeenCalledTimes(1);
      await expect(clearPersistentUiState({ skipIndexedDb: true })).rejects.toThrow(
        'OS keychain refused deletion'
      );
    } finally {
      Reflect.deleteProperty(globalWindow, 'electronAPI');
      Reflect.deleteProperty(globalWindow, 'secrets');
      Reflect.deleteProperty(globalWindow, 'settings');
    }
  });

  it('deletes every CacheStorage entry and verifies the reset', async () => {
    const keysMock = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['runtime-cache', 'model-cache'])
      .mockResolvedValueOnce([]);
    const deleteMock = vi.fn(async () => true);
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: {
        delete: deleteMock,
        keys: keysMock,
      } as unknown as CacheStorage,
    });

    await clearPersistentUiState({ skipIndexedDb: true });

    expect(deleteMock).toHaveBeenCalledWith('runtime-cache');
    expect(deleteMock).toHaveBeenCalledWith('model-cache');
    expect(keysMock).toHaveBeenCalledTimes(2);
  });

  it('fails when CacheStorage entries survive deletion', async () => {
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: {
        delete: vi.fn(async () => false),
        keys: vi.fn(async () => ['runtime-cache']),
      } as unknown as CacheStorage,
    });

    await expect(clearPersistentUiState({ skipIndexedDb: true })).rejects.toThrow(
      /CacheStorage reset incomplete/
    );
  });

  it('does not fail when CacheStorage delete reports false but verification shows no entries remain', async () => {
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: {
        delete: vi.fn(async () => false),
        keys: vi.fn().mockResolvedValueOnce(['runtime-cache']).mockResolvedValueOnce([]),
      } as unknown as CacheStorage,
    });

    await expect(clearPersistentUiState({ skipIndexedDb: true })).resolves.toBeUndefined();
  });
});

describe('clearPersistentUiState OPFS-AHP handling', () => {
  const nav = globalThis.navigator as Navigator & {
    storage?: { getDirectory?: () => Promise<unknown> };
  };
  let originalStorageDescriptor: PropertyDescriptor | undefined;
  let originalIndexedDB: IDBFactory | undefined;
  let originalCaches: CacheStorage | undefined;
  let removeEntry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalIndexedDB = globalWindow.indexedDB;
    originalCaches = globalWindow.caches;
    originalStorageDescriptor = Object.getOwnPropertyDescriptor(nav, 'storage');

    // Minimal IndexedDB + CacheStorage so the sibling reset tasks complete cleanly.
    Object.defineProperty(globalWindow, 'indexedDB', {
      configurable: true,
      value: { deleteDatabase: createDeleteDatabaseMock() } as unknown as IDBFactory,
    });
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: {
        delete: vi.fn(async () => true),
        keys: vi.fn(async () => []),
      } as unknown as CacheStorage,
    });

    removeEntry = vi.fn(async () => undefined);
    async function* keys(): AsyncGenerator<string> {
      yield 'app-pg18'; // current versioned
      yield 'app'; // legacy unversioned
      yield 'app-pg17'; // older major
      yield 'web-pg18';
      yield 'brainstrike-notes'; // notes vault default — must be wiped even when pglite dirs exist
      yield 'brainstrike-web-state-default'; // browser state DB pools
      yield 'brainstrike-web-state-web-e2e-1';
      yield 'brainstrike-web-state-default--files'; // the file index's own pool
      yield 'some-other-lib'; // unrelated OPFS consumer → must NOT be removed
    }
    Object.defineProperty(nav, 'storage', {
      configurable: true,
      value: { getDirectory: vi.fn(async () => ({ keys, removeEntry })) },
    });
  });

  afterEach(() => {
    if (originalIndexedDB) {
      Object.defineProperty(globalWindow, 'indexedDB', {
        configurable: true,
        value: originalIndexedDB,
      });
    } else {
      Reflect.deleteProperty(globalWindow, 'indexedDB');
    }
    if (originalCaches) {
      Object.defineProperty(globalWindow, 'caches', { configurable: true, value: originalCaches });
    } else {
      Reflect.deleteProperty(globalWindow, 'caches');
    }
    if (originalStorageDescriptor) {
      Object.defineProperty(nav, 'storage', originalStorageDescriptor);
    } else {
      Reflect.deleteProperty(nav, 'storage');
    }
  });

  it('removes the pglite OPFS-AHP root dirs (versioned + legacy + older majors), never unrelated entries', async () => {
    await clearPersistentUiState();

    const removed = removeEntry.mock.calls.map(([name]) => name);
    expect(removed).toEqual(expect.arrayContaining(['app-pg18', 'app', 'app-pg17', 'web-pg18']));
    // A non-pglite OPFS consumer's root dir must never be swept by factory reset.
    expect(removed).not.toContain('some-other-lib');
  });

  it('wipes the notes vault OPFS dir even when pglite dirs are enumerated (reset must not skip it)', async () => {
    await clearPersistentUiState();

    // Regression: enumeration finding pglite dirs used to bypass the fallback
    // list entirely, leaving brainstrike-notes (note plaintext) alive.
    expect(removeEntry.mock.calls.map(([name]) => name)).toContain('brainstrike-notes');
  });

  it('removes every browser state DB pool', async () => {
    await clearPersistentUiState();

    expect(removeEntry.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'brainstrike-web-state-default',
        'brainstrike-web-state-web-e2e-1',
        'brainstrike-web-state-default--files',
      ])
    );
  });

  it("removes the default store's pools, its file index's too, where OPFS cannot list its entries", async () => {
    Object.defineProperty(nav, 'storage', {
      configurable: true,
      value: { getDirectory: vi.fn(async () => ({ removeEntry })) },
    });

    await clearPersistentUiState();

    expect(removeEntry.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'brainstrike-web-state-default',
        'brainstrike-web-state-default--files',
      ])
    );
  });

  it('reports incomplete reset results when an OPFS pglite directory cannot be removed', async () => {
    const resetFailure = new Error('locked opfs directory');
    removeEntry.mockImplementation(async (name: string) => {
      if (name === 'app-pg18') {
        throw resetFailure;
      }
    });

    const result: ClearPersistentUiStateResult = await clearPersistentUiStateWithResult();

    expect(result.success).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      error: resetFailure,
      name: 'app-pg18',
      operation: 'removeEntry',
      target: 'opfs-pglite',
    });
  });

  it('reports incomplete reset results when OPFS pglite directory enumeration fails', async () => {
    const enumerateFailure = new Error('opfs enumeration failed');
    async function* keys(): AsyncGenerator<string> {
      yield 'app-pg18';
      throw enumerateFailure;
    }
    Object.defineProperty(nav, 'storage', {
      configurable: true,
      value: { getDirectory: vi.fn(async () => ({ keys, removeEntry })) },
    });

    const result: ClearPersistentUiStateResult = await clearPersistentUiStateWithResult();

    expect(removeEntry).toHaveBeenCalledWith('app-pg18', { recursive: true });
    expect(result.success).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      error: enumerateFailure,
      operation: 'enumerate',
      target: 'opfs-pglite',
    });
  });

  it('rejects the void reset API when OPFS cleanup is incomplete', async () => {
    const resetFailure = new Error('locked opfs directory');
    removeEntry.mockImplementation(async (name: string) => {
      if (name === 'app-pg18') {
        throw resetFailure;
      }
    });

    let thrown: unknown;
    try {
      await clearPersistentUiState();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      result: {
        failures: [
          expect.objectContaining({
            error: resetFailure,
            name: 'app-pg18',
            operation: 'removeEntry',
            target: 'opfs-pglite',
          }),
        ],
        success: false,
      },
    });
  });
});
