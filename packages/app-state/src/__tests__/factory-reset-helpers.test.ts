import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClearPersistentUiStateIncompleteError,
  clearPersistentUiState,
  clearPersistentUiStateWithResult,
  prepareFactoryReset,
  registerFactoryResetPreparation,
  registerFactoryResetSessionStore,
} from '../factory-reset.ts';

interface FakeRequest {
  error?: DOMException | null;
  onblocked: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onsuccess: ((event: Event) => void) | null;
}

const RENDERER_DATABASE = 'renderer-db';

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
        databases: vi.fn(async () => [{ name: RENDERER_DATABASE }]),
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

  it('reports an incomplete reset when IndexedDB cannot enumerate its databases', async () => {
    Object.defineProperty(globalWindow, 'indexedDB', {
      configurable: true,
      value: { deleteDatabase: deleteDatabaseMock } as unknown as IDBFactory,
    });

    const result = await clearPersistentUiStateWithResult();

    expect(result.success).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({ operation: 'enumerate', target: 'indexed-db' }),
    ]);
    expect(deleteDatabaseMock).not.toHaveBeenCalled();
  });

  it('reports an incomplete reset when IndexedDB enumeration throws', async () => {
    const enumerationFailure = new Error('no enumeration');
    Object.defineProperty(globalWindow, 'indexedDB', {
      configurable: true,
      value: {
        databases: vi.fn(async () => {
          throw enumerationFailure;
        }),
        deleteDatabase: deleteDatabaseMock,
      } as unknown as IDBFactory,
    });

    const result = await clearPersistentUiStateWithResult();

    expect(result.failures).toEqual([
      { error: enumerationFailure, operation: 'enumerate', target: 'indexed-db' },
    ]);
    await expect(clearPersistentUiState()).rejects.toBeInstanceOf(
      ClearPersistentUiStateIncompleteError
    );
    expect(deleteDatabaseMock).not.toHaveBeenCalled();
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
          name: RENDERER_DATABASE,
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
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      error: deletionFailure,
      name: RENDERER_DATABASE,
      operation: 'delete',
      target: 'indexed-db',
    });
    const reset = clearPersistentUiState();
    await expect(reset).rejects.toBeInstanceOf(ClearPersistentUiStateIncompleteError);
    await expect(reset).rejects.toMatchObject({
      message: expect.stringContaining('IndexedDB bridge crashed'),
      result: expect.objectContaining({ success: false }),
    });
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
      const reset = clearPersistentUiState({ skipIndexedDb: true });
      await expect(reset).rejects.toBeInstanceOf(ClearPersistentUiStateIncompleteError);
      await expect(reset).rejects.toMatchObject({
        message: expect.stringContaining('OS keychain refused deletion'),
        result: expect.objectContaining({ success: false }),
      });
    } finally {
      Reflect.deleteProperty(globalWindow, 'electronAPI');
      Reflect.deleteProperty(globalWindow, 'secrets');
      Reflect.deleteProperty(globalWindow, 'settings');
    }
  });

  it('deletes every CacheStorage entry and verifies the reset', async () => {
    const keysMock = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['runtime-cache', 'response-cache'])
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
    expect(deleteMock).toHaveBeenCalledWith('response-cache');
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

    const reset = clearPersistentUiState({ skipIndexedDb: true });
    await expect(reset).rejects.toBeInstanceOf(ClearPersistentUiStateIncompleteError);
    await expect(reset).rejects.toMatchObject({
      message: expect.stringMatching(/CacheStorage reset incomplete/u),
      result: expect.objectContaining({ success: false }),
    });
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
