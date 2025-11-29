import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistentUiState,
  FALLBACK_INDEXED_DB_NAMES,
} from '../settings/system/factory-reset-helpers';

type FakeRequest = {
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onblocked: ((event: Event) => void) | null;
};

const globalWindow = window as Window &
  typeof globalThis & {
    indexedDB?: IDBFactory;
    caches?: CacheStorage;
  };

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
});
