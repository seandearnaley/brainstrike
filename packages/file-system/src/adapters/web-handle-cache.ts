import { encodeFileSelection } from '@brainstrike/utils';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

// Keep this name in sync with factory-reset fallback IndexedDB list.
const DB_NAME = 'brainstrike-file-handles';
const DB_VERSION = 1;

const ROOT_STORE = 'root-handles';
const FILE_STORE = 'file-handles';
const ROOT_LAST_ACCESSED_INDEX = 'by-last-accessed';
const FILE_BY_FOLDER_INDEX = 'by-folder';

const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

const now = () => Date.now();

export interface StoredRootHandle {
  folderId: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  storedAt: number;
  lastAccessedAt: number;
}

export interface StoredFileHandle {
  path: string;
  name: string;
  handle: FileSystemFileHandle;
  folderId: string;
  storedAt: number;
}

interface HandleCacheSchema extends DBSchema {
  [ROOT_STORE]: {
    key: string;
    value: StoredRootHandle;
    indexes: { [ROOT_LAST_ACCESSED_INDEX]: number };
  };
  [FILE_STORE]: {
    key: string;
    value: StoredFileHandle;
    indexes: { [FILE_BY_FOLDER_INDEX]: string };
  };
}

const isDirectoryHandle = (handle: unknown): handle is FileSystemDirectoryHandle =>
  !!handle &&
  typeof handle === 'object' &&
  (handle as { kind?: unknown }).kind === 'directory' &&
  typeof (handle as { name?: unknown }).name === 'string' &&
  'entries' in handle;

const isFileHandle = (handle: unknown): handle is FileSystemFileHandle =>
  !!handle &&
  typeof handle === 'object' &&
  (handle as { kind?: unknown }).kind === 'file' &&
  typeof (handle as { name?: unknown }).name === 'string' &&
  'getFile' in handle;

export interface HandleCache {
  storeRootHandle(folderId: string, handle: FileSystemDirectoryHandle): Promise<void>;
  getRootHandle(folderId: string): Promise<FileSystemDirectoryHandle | null>;
  getAllRootHandles(): Promise<StoredRootHandle[]>;
  removeRootHandle(folderId: string): Promise<void>;
  restoreLastRootHandle(): Promise<{ handle: FileSystemDirectoryHandle } | null>;
  storeFileHandle(
    folderId: string,
    relativePath: string,
    handle: FileSystemFileHandle
  ): Promise<void>;
  getFileHandle(folderId: string, relativePath: string): Promise<FileSystemFileHandle | null>;
  removeFileHandle(folderId: string, relativePath: string): Promise<void>;
  clear(): Promise<void>;
  pruneOldHandles(maxAge?: number): Promise<void>;
}

export class WebHandleCache implements HandleCache {
  private dbPromise: Promise<IDBPDatabase<HandleCacheSchema>> | null = null;
  private indexedDbAvailable =
    typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
  private readonly memoryRootHandles = new Map<string, StoredRootHandle>();
  private readonly memoryFileHandles = new Map<string, StoredFileHandle>();

  private async getDb(): Promise<IDBPDatabase<HandleCacheSchema> | null> {
    if (!this.indexedDbAvailable) {
      return null;
    }

    if (!this.dbPromise) {
      this.dbPromise = openDB<HandleCacheSchema>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(ROOT_STORE)) {
            const store = db.createObjectStore(ROOT_STORE, { keyPath: 'folderId' });
            store.createIndex(ROOT_LAST_ACCESSED_INDEX, 'lastAccessedAt');
          }
          if (!db.objectStoreNames.contains(FILE_STORE)) {
            const store = db.createObjectStore(FILE_STORE, { keyPath: 'path' });
            store.createIndex(FILE_BY_FOLDER_INDEX, 'folderId');
          }
        },
      });
    }

    try {
      return await this.dbPromise;
    } catch {
      this.dbPromise = null;
      this.indexedDbAvailable = false;
      return null;
    }
  }

  private buildFileKey(folderId: string, relativePath: string): string {
    return encodeFileSelection(folderId, relativePath);
  }

  private async updateRootRecord(record: StoredRootHandle): Promise<void> {
    this.memoryRootHandles.set(record.folderId, record);
    const db = await this.getDb();
    if (!db) {
      return;
    }
    try {
      await db.put(ROOT_STORE, record);
    } catch {
      // Ignore persistence failures; in-memory copy remains.
    }
  }

  private async updateFileRecord(record: StoredFileHandle): Promise<void> {
    this.memoryFileHandles.set(record.path, record);
    const db = await this.getDb();
    if (!db) {
      return;
    }
    try {
      await db.put(FILE_STORE, record);
    } catch {
      // Ignore persistence failures; in-memory copy remains.
    }
  }

  async storeRootHandle(folderId: string, handle: FileSystemDirectoryHandle): Promise<void> {
    const timestamp = now();
    const existing = this.memoryRootHandles.get(folderId);
    const record: StoredRootHandle = {
      folderId,
      name: handle.name,
      handle,
      storedAt: existing?.storedAt ?? timestamp,
      lastAccessedAt: timestamp,
    };
    await this.updateRootRecord(record);
  }

  async getRootHandle(folderId: string): Promise<FileSystemDirectoryHandle | null> {
    const db = await this.getDb();
    if (db) {
      try {
        const record = await db.get(ROOT_STORE, folderId);
        if (record && isDirectoryHandle(record.handle)) {
          const updated: StoredRootHandle = {
            ...record,
            lastAccessedAt: now(),
          };
          await this.updateRootRecord(updated);
          return updated.handle;
        }
      } catch {
        // Fall back to memory cache.
      }
    }

    const fallback = this.memoryRootHandles.get(folderId);
    if (fallback && isDirectoryHandle(fallback.handle)) {
      const updated: StoredRootHandle = {
        ...fallback,
        lastAccessedAt: now(),
      };
      this.memoryRootHandles.set(folderId, updated);
      return updated.handle;
    }
    return null;
  }

  async getAllRootHandles(): Promise<StoredRootHandle[]> {
    const db = await this.getDb();
    if (db) {
      try {
        const records = await db.getAll(ROOT_STORE);
        for (const record of records) {
          this.memoryRootHandles.set(record.folderId, record);
        }
        const merged = new Map<string, StoredRootHandle>();
        for (const record of records) {
          merged.set(record.folderId, record);
        }
        for (const record of this.memoryRootHandles.values()) {
          merged.set(record.folderId, record);
        }
        return Array.from(merged.values());
      } catch {
        // Fall back to memory cache.
      }
    }

    return Array.from(this.memoryRootHandles.values());
  }

  async removeRootHandle(folderId: string): Promise<void> {
    this.memoryRootHandles.delete(folderId);
    for (const [key, record] of this.memoryFileHandles) {
      if (record.folderId === folderId) {
        this.memoryFileHandles.delete(key);
      }
    }

    const db = await this.getDb();
    if (!db) {
      return;
    }

    try {
      const tx = db.transaction([ROOT_STORE, FILE_STORE], 'readwrite');
      await tx.objectStore(ROOT_STORE).delete(folderId);
      const fileIndex = tx.objectStore(FILE_STORE).index(FILE_BY_FOLDER_INDEX);
      let cursor = await fileIndex.openCursor(folderId);
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    } catch {
      // Ignore delete failures.
    }
  }

  async restoreLastRootHandle(): Promise<{ handle: FileSystemDirectoryHandle } | null> {
    const db = await this.getDb();
    let record: StoredRootHandle | null = null;

    if (db) {
      try {
        const index = db.transaction(ROOT_STORE).store.index(ROOT_LAST_ACCESSED_INDEX);
        const cursor = await index.openCursor(null, 'prev');
        record = cursor?.value ?? null;
      } catch {
        record = null;
      }
    }

    if (!record) {
      record =
        Array.from(this.memoryRootHandles.values()).sort(
          (a, b) => b.lastAccessedAt - a.lastAccessedAt
        )[0] ?? null;
    }

    if (!(record && isDirectoryHandle(record.handle))) {
      return null;
    }

    try {
      if (typeof record.handle.queryPermission === 'function') {
        const permission = await record.handle.queryPermission({ mode: 'read' });
        if (permission === 'granted') {
          await this.updateRootRecord({ ...record, lastAccessedAt: now() });
          return { handle: record.handle };
        }
        if (permission === 'denied') {
          return null;
        }
        if (typeof record.handle.requestPermission === 'function') {
          const requested = await record.handle.requestPermission({ mode: 'read' });
          if (requested === 'granted') {
            await this.updateRootRecord({ ...record, lastAccessedAt: now() });
            return { handle: record.handle };
          }
        }
        return null;
      }

      await this.updateRootRecord({ ...record, lastAccessedAt: now() });
      return { handle: record.handle };
    } catch {
      await this.removeRootHandle(record.folderId);
      return null;
    }
  }

  async storeFileHandle(
    folderId: string,
    relativePath: string,
    handle: FileSystemFileHandle
  ): Promise<void> {
    const timestamp = now();
    const path = this.buildFileKey(folderId, relativePath);
    const existing = this.memoryFileHandles.get(path);
    const record: StoredFileHandle = {
      path,
      name: handle.name,
      handle,
      folderId,
      storedAt: existing?.storedAt ?? timestamp,
    };
    await this.updateFileRecord(record);
  }

  async getFileHandle(
    folderId: string,
    relativePath: string
  ): Promise<FileSystemFileHandle | null> {
    const path = this.buildFileKey(folderId, relativePath);
    const db = await this.getDb();
    if (db) {
      try {
        const record = await db.get(FILE_STORE, path);
        if (record && isFileHandle(record.handle)) {
          this.memoryFileHandles.set(path, record);
          return record.handle;
        }
      } catch {
        // Fall back to memory cache.
      }
    }

    const fallback = this.memoryFileHandles.get(path);
    if (fallback && isFileHandle(fallback.handle)) {
      return fallback.handle;
    }
    return null;
  }

  async removeFileHandle(folderId: string, relativePath: string): Promise<void> {
    const path = this.buildFileKey(folderId, relativePath);
    this.memoryFileHandles.delete(path);

    const db = await this.getDb();
    if (!db) {
      return;
    }
    try {
      await db.delete(FILE_STORE, path);
    } catch {
      // Ignore delete failures.
    }
  }

  async clear(): Promise<void> {
    this.memoryRootHandles.clear();
    this.memoryFileHandles.clear();

    const db = await this.getDb();
    if (!db) {
      return;
    }

    try {
      const tx = db.transaction([ROOT_STORE, FILE_STORE], 'readwrite');
      await tx.objectStore(ROOT_STORE).clear();
      await tx.objectStore(FILE_STORE).clear();
      await tx.done;
    } catch {
      // Ignore clear failures.
    }
  }

  async pruneOldHandles(maxAge: number = DEFAULT_MAX_AGE_MS): Promise<void> {
    const cutoff = now() - maxAge;

    for (const [folderId, record] of this.memoryRootHandles) {
      if (record.storedAt < cutoff) {
        this.memoryRootHandles.delete(folderId);
      }
    }

    for (const [path, record] of this.memoryFileHandles) {
      if (record.storedAt < cutoff) {
        this.memoryFileHandles.delete(path);
      }
    }

    const db = await this.getDb();
    if (!db) {
      return;
    }

    try {
      const tx = db.transaction([ROOT_STORE, FILE_STORE], 'readwrite');
      const rootStore = tx.objectStore(ROOT_STORE);
      const fileStore = tx.objectStore(FILE_STORE);

      let rootCursor = await rootStore.openCursor();
      while (rootCursor) {
        if (rootCursor.value.storedAt < cutoff) {
          await rootCursor.delete();
        }
        rootCursor = await rootCursor.continue();
      }

      let fileCursor = await fileStore.openCursor();
      while (fileCursor) {
        if (fileCursor.value.storedAt < cutoff) {
          await fileCursor.delete();
        }
        fileCursor = await fileCursor.continue();
      }

      await tx.done;
    } catch {
      // Ignore prune failures.
    }
  }
}
