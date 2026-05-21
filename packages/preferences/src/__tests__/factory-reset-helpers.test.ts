import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistentUiState,
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
});
