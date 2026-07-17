import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type StoredFileHandle,
  type StoredRootHandle,
  WebHandleCache,
} from '../adapters/web-handle-cache';

const { mockDeleteDatabase, mockOpenDb } = vi.hoisted(() => ({
  mockDeleteDatabase: vi.fn(),
  mockOpenDb: vi.fn(),
}));

vi.mock('idb', () => ({
  openDB: mockOpenDb,
}));

const ROOT_STORE = 'root-handles' as const;
const FILE_STORE = 'file-handles' as const;
const ROOT_LAST_ACCESSED_INDEX = 'by-last-accessed' as const;
const FILE_BY_FOLDER_INDEX = 'by-folder' as const;

interface MockObjectStoreNames {
  contains: (name: string) => boolean;
  [Symbol.iterator]: () => Iterator<string>;
}

interface MockUpgradeDb {
  createObjectStore: (
    name: string,
    options: { keyPath: string }
  ) => {
    createIndex: (name: string, keyPath: string) => void;
  };
  objectStoreNames: MockObjectStoreNames;
  version: number;
}

interface MockOpenDbOptions {
  upgrade?: (db: MockUpgradeDb) => void;
}

interface MockCursor<TRecord> {
  continue: () => Promise<MockCursor<TRecord> | null>;
  delete: () => Promise<void>;
  readonly value: TRecord;
}

interface MockStore<TRecord> {
  clear: () => Promise<void>;
  delete: (key: string) => Promise<void>;
  index: (name: string) => {
    openCursor: (query?: string | null, direction?: 'prev') => Promise<MockCursor<TRecord> | null>;
  };
  openCursor: () => Promise<MockCursor<TRecord> | null>;
}

interface MockTransaction {
  done: Promise<void>;
  objectStore: (name: string) => MockStore<StoredRootHandle> | MockStore<StoredFileHandle>;
  store: MockStore<StoredRootHandle>;
}

interface MockDb {
  close: () => void;
  delete: (storeName: string, key: string) => Promise<void>;
  get: (storeName: string, key: string) => Promise<StoredRootHandle | StoredFileHandle | undefined>;
  getAll: (storeName: string) => Promise<StoredRootHandle[] | StoredFileHandle[]>;
  objectStoreNames: MockObjectStoreNames;
  put: (storeName: string, record: StoredRootHandle | StoredFileHandle) => Promise<void>;
  transaction: (storeNames?: string | string[], mode?: 'readwrite') => MockTransaction;
}

interface MockDbState {
  close: ReturnType<typeof vi.fn>;
  db: MockDb;
  fileRecords: Map<string, StoredFileHandle>;
  rootRecords: Map<string, StoredRootHandle>;
  upgradeDb: MockUpgradeDb;
}

const createObjectStoreNames = (names: Set<string>): MockObjectStoreNames => ({
  contains: (name: string) => names.has(name),
  [Symbol.iterator]: () => names.values(),
});

function createCursor<TRecord>(
  records: TRecord[],
  deleteRecord: (record: TRecord) => void
): MockCursor<TRecord> | null {
  if (records.length === 0) {
    return null;
  }

  let index = 0;
  const cursor: MockCursor<TRecord> = {
    continue: async () => {
      index += 1;
      return index < records.length ? cursor : null;
    },
    delete: async () => {
      deleteRecord(records[index] as TRecord);
    },
    get value() {
      return records[index] as TRecord;
    },
  };
  return cursor;
}

function createMockDb(
  options: { hasFileStore?: boolean; hasRootStore?: boolean } = {}
): MockDbState {
  const storeNames = new Set<string>();
  if (options.hasRootStore ?? true) {
    storeNames.add(ROOT_STORE);
  }
  if (options.hasFileStore ?? true) {
    storeNames.add(FILE_STORE);
  }

  const rootRecords = new Map<string, StoredRootHandle>();
  const fileRecords = new Map<string, StoredFileHandle>();
  const close = vi.fn();

  const rootStore = (): MockStore<StoredRootHandle> => ({
    clear: async () => {
      rootRecords.clear();
    },
    delete: async (key: string) => {
      rootRecords.delete(key);
    },
    index: (name: string) => {
      expect(name).toBe(ROOT_LAST_ACCESSED_INDEX);
      return {
        openCursor: async (_query?: string | null, direction?: 'prev') => {
          const records = Array.from(rootRecords.values());
          if (direction === 'prev') {
            records.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
          }
          return createCursor(records, (record) => {
            rootRecords.delete(record.folderId);
          });
        },
      };
    },
    openCursor: async () =>
      createCursor(Array.from(rootRecords.values()), (record) => {
        rootRecords.delete(record.folderId);
      }),
  });

  const fileStore = (): MockStore<StoredFileHandle> => ({
    clear: async () => {
      fileRecords.clear();
    },
    delete: async (key: string) => {
      fileRecords.delete(key);
    },
    index: (name: string) => {
      expect(name).toBe(FILE_BY_FOLDER_INDEX);
      return {
        openCursor: async (folderId?: string | null) =>
          createCursor(
            Array.from(fileRecords.values()).filter((record) => record.folderId === folderId),
            (record) => {
              fileRecords.delete(record.path);
            }
          ),
      };
    },
    openCursor: async () =>
      createCursor(Array.from(fileRecords.values()), (record) => {
        fileRecords.delete(record.path);
      }),
  });

  const db: MockDb = {
    close,
    delete: async (storeName, key) => {
      if (storeName === ROOT_STORE) {
        rootRecords.delete(key);
        return;
      }
      fileRecords.delete(key);
    },
    get: async (storeName, key) =>
      storeName === ROOT_STORE ? rootRecords.get(key) : fileRecords.get(key),
    getAll: async (storeName) =>
      storeName === ROOT_STORE
        ? Array.from(rootRecords.values())
        : Array.from(fileRecords.values()),
    objectStoreNames: createObjectStoreNames(storeNames),
    put: async (storeName, record) => {
      if (storeName === ROOT_STORE) {
        rootRecords.set((record as StoredRootHandle).folderId, record as StoredRootHandle);
        return;
      }
      fileRecords.set((record as StoredFileHandle).path, record as StoredFileHandle);
    },
    transaction: () => ({
      done: Promise.resolve(),
      objectStore: (name: string) => (name === ROOT_STORE ? rootStore() : fileStore()),
      store: rootStore(),
    }),
  };

  const upgradeDb: MockUpgradeDb = {
    createObjectStore: (name: string) => {
      storeNames.add(name);
      return {
        createIndex: vi.fn(),
      };
    },
    objectStoreNames: createObjectStoreNames(storeNames),
    version: 1,
  };

  return {
    close,
    db,
    fileRecords,
    rootRecords,
    upgradeDb,
  };
}

function createDirectoryHandle(name: string): FileSystemDirectoryHandle {
  return {
    entries: vi.fn(),
    kind: 'directory',
    name,
    queryPermission: vi.fn().mockResolvedValue('granted'),
  } as unknown as FileSystemDirectoryHandle;
}

function createFileHandle(name: string): FileSystemFileHandle {
  return {
    getFile: vi.fn(),
    kind: 'file',
    name,
  } as unknown as FileSystemFileHandle;
}

function createRootRecord(
  folderId: string,
  handle: FileSystemDirectoryHandle,
  storedAt: number
): StoredRootHandle {
  return {
    folderId,
    handle,
    lastAccessedAt: storedAt,
    name: handle.name,
    storedAt,
  };
}

function createFileRecord(
  folderId: string,
  path: string,
  handle: FileSystemFileHandle,
  storedAt: number
): StoredFileHandle {
  return {
    folderId,
    handle,
    name: handle.name,
    path,
    storedAt,
  };
}

function installMockIndexedDb(state: MockDbState): void {
  mockOpenDb.mockImplementation(
    async (_name: string, _version: number, options?: MockOpenDbOptions) => {
      options?.upgrade?.(state.upgradeDb);
      return state.db;
    }
  );
}

describe('WebHandleCache IndexedDB unit boundary', () => {
  let mockedNow = new Date('2025-01-01T00:00:00.000Z').getTime();

  beforeEach(() => {
    mockedNow = new Date('2025-01-01T00:00:00.000Z').getTime();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.spyOn(Date, 'now').mockImplementation(() => mockedNow);
    mockDeleteDatabase.mockImplementation(() => {
      const request: {
        error: Error | null;
        onblocked: (() => void) | null;
        onerror: (() => void) | null;
        onsuccess: (() => void) | null;
      } = {
        error: null,
        onblocked: null,
        onerror: null,
        onsuccess: null,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    });
    vi.stubGlobal('indexedDB', {
      deleteDatabase: mockDeleteDatabase,
    });
  });

  it('writes and reads root and file handles through IndexedDB', async () => {
    const state = createMockDb();
    installMockIndexedDb(state);
    const folderId = 'indexeddb-read-root';
    const rootHandle = createDirectoryHandle(folderId);
    const fileHandle = createFileHandle('indexeddb-read.txt');
    const writer = new WebHandleCache();

    await writer.storeRootHandle(folderId, rootHandle);
    await writer.storeFileHandle(folderId, 'indexeddb-read.txt', fileHandle);

    const reader = new WebHandleCache();

    await expect(reader.getRootHandle(folderId)).resolves.toBe(rootHandle);
    await expect(reader.getFileHandle(folderId, 'indexeddb-read.txt')).resolves.toBe(fileHandle);
  });

  it('updates restore timestamps from IndexedDB when memory is empty', async () => {
    const state = createMockDb();
    installMockIndexedDb(state);
    const folderId = 'indexeddb-restored-root';
    state.rootRecords.set(
      folderId,
      createRootRecord(folderId, createDirectoryHandle(folderId), mockedNow)
    );
    mockedNow = new Date('2025-01-04T00:00:00.000Z').getTime();

    await new WebHandleCache().markHandleRestored(folderId);

    expect(state.rootRecords.get(folderId)?.lastAccessedAt).toBe(mockedNow);
  });

  it('removes IndexedDB file handles that belong to a removed root', async () => {
    const state = createMockDb();
    installMockIndexedDb(state);
    const folderId = 'indexeddb-remove-root';
    state.rootRecords.set(
      folderId,
      createRootRecord(folderId, createDirectoryHandle(folderId), mockedNow)
    );
    state.fileRecords.set(
      'first-key',
      createFileRecord(folderId, 'first-key', createFileHandle('first.txt'), mockedNow)
    );
    state.fileRecords.set(
      'second-key',
      createFileRecord(folderId, 'second-key', createFileHandle('second.txt'), mockedNow)
    );
    state.fileRecords.set(
      'other-key',
      createFileRecord('other-root', 'other-key', createFileHandle('other.txt'), mockedNow)
    );

    await new WebHandleCache().removeRootHandle(folderId);

    expect(state.rootRecords.has(folderId)).toBe(false);
    expect(state.fileRecords.has('first-key')).toBe(false);
    expect(state.fileRecords.has('second-key')).toBe(false);
    expect(state.fileRecords.has('other-key')).toBe(true);
  });

  it('prunes old IndexedDB root and file handles with cursors', async () => {
    const state = createMockDb();
    installMockIndexedDb(state);
    const oldTimestamp = mockedNow;
    const freshTimestamp = new Date('2025-01-15T00:00:00.000Z').getTime();
    state.rootRecords.set(
      'old-root',
      createRootRecord('old-root', createDirectoryHandle('old-root'), oldTimestamp)
    );
    state.rootRecords.set(
      'fresh-root',
      createRootRecord('fresh-root', createDirectoryHandle('fresh-root'), freshTimestamp)
    );
    state.fileRecords.set(
      'old-file',
      createFileRecord('old-root', 'old-file', createFileHandle('old.txt'), oldTimestamp)
    );
    state.fileRecords.set(
      'fresh-file',
      createFileRecord('fresh-root', 'fresh-file', createFileHandle('fresh.txt'), freshTimestamp)
    );
    mockedNow = new Date('2025-02-01T00:00:00.000Z').getTime();

    await new WebHandleCache().pruneOldHandles(1000 * 60 * 60 * 24 * 20);

    expect(state.rootRecords.has('old-root')).toBe(false);
    expect(state.rootRecords.has('fresh-root')).toBe(true);
    expect(state.fileRecords.has('old-file')).toBe(false);
    expect(state.fileRecords.has('fresh-file')).toBe(true);
  });

  it('recreates a corrupted IndexedDB database that is missing stores', async () => {
    const corruptedState = createMockDb({ hasFileStore: false, hasRootStore: true });
    const recoveredState = createMockDb();
    mockOpenDb
      .mockResolvedValueOnce(corruptedState.db)
      .mockImplementationOnce(
        async (_name: string, _version: number, options?: MockOpenDbOptions) => {
          options?.upgrade?.(recoveredState.upgradeDb);
          return recoveredState.db;
        }
      );

    await expect(new WebHandleCache().getAllRootHandles()).resolves.toEqual([]);

    expect(corruptedState.close).toHaveBeenCalledOnce();
    expect(mockDeleteDatabase).toHaveBeenCalledWith('brainstrike-file-handles');
    expect(mockOpenDb).toHaveBeenCalledTimes(2);
  });
});
