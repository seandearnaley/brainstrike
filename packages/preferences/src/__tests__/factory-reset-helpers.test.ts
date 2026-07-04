import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClearPersistentUiStateResult } from '../settings/system/factory-reset-helpers';
import {
  clearPersistentUiState,
  clearPersistentUiStateWithResult,
  FALLBACK_INDEXED_DB_NAMES,
} from '../settings/system/factory-reset-helpers';

interface FakeRequest {
  onblocked: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onsuccess: ((event: Event) => void) | null;
}

const globalWindow = window as Window &
  typeof globalThis & {
    indexedDB?: IDBFactory;
    caches?: CacheStorage;
  };

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
      onsuccess: null,
      onerror: null,
      onblocked: null,
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
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
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
        deleteDatabase: deleteDatabaseMock,
        databases: databasesMock,
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
        deleteDatabase: deleteDatabaseMock,
        databases: databasesMock,
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
        keys: vi.fn(async () => []),
        delete: vi.fn(async () => true),
      } as unknown as CacheStorage,
    });

    removeEntry = vi.fn(async () => undefined);
    async function* keys(): AsyncGenerator<string> {
      yield 'app-pg18'; // current versioned
      yield 'app'; // legacy unversioned
      yield 'app-pg17'; // older major
      yield 'web-pg18';
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

  it('removes browser Turso WASM OPFS database files and sidecars without sweeping unrelated files', async () => {
    async function* keys(): AsyncGenerator<string> {
      yield 'brainstrike-web-turso.db';
      yield 'brainstrike-web-turso.db-wal';
      yield 'brainstrike-web-turso.db-shm';
      yield 'some-other-lib.db';
    }
    Object.defineProperty(nav, 'storage', {
      configurable: true,
      value: { getDirectory: vi.fn(async () => ({ keys, removeEntry })) },
    });

    await clearPersistentUiState();

    const removed = removeEntry.mock.calls.map(([name]) => name);
    expect(removed).toEqual(
      expect.arrayContaining([
        'brainstrike-web-turso.db',
        'brainstrike-web-turso.db-wal',
        'brainstrike-web-turso.db-shm',
      ])
    );
    expect(removed).not.toContain('some-other-lib.db');
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
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: enumerateFailure,
          operation: 'enumerate',
          target: 'opfs-pglite',
        }),
        expect.objectContaining({
          error: enumerateFailure,
          operation: 'enumerate',
          target: 'opfs-turso-browser-wasm',
        }),
      ])
    );
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
