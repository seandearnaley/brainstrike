import { createLogger, encodeFileSelection } from '@brainstrike/utils';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

const logger = createLogger('WebHandleCache');

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

/**
 * Request permission from user with timeout protection.
 * requestPermission() requires a user gesture and may hang indefinitely if called without one.
 * Returns 'granted', 'denied', 'prompt', 'timeout', or 'error'.
 */
async function requestPermissionWithTimeout(
  handle: FileSystemDirectoryHandle,
  timeoutMs = 10_000
): Promise<PermissionState | 'timeout' | 'error'> {
  logger.debug('requestPermissionWithTimeout: starting', {
    handleName: handle.name,
    timeoutMs,
    hasRequestPermission: typeof handle.requestPermission === 'function',
  });

  if (typeof handle.requestPermission !== 'function') {
    logger.warn('requestPermissionWithTimeout: handle lacks requestPermission method');
    return 'error';
  }

  try {
    logger.debug('requestPermissionWithTimeout: calling handle.requestPermission()');
    const startTime = Date.now();

    const permissionPromise = handle.requestPermission({ mode: 'read' });
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      const timeoutId = setTimeout(() => {
        logger.warn('requestPermissionWithTimeout: timeout triggered after', {
          elapsedMs: Date.now() - startTime,
          timeoutMs,
        });
        resolve('timeout');
      }, timeoutMs);
      // Ensure the timeout doesn't prevent process exit in Node.js environments
      if (typeof timeoutId === 'object' && 'unref' in timeoutId) {
        (timeoutId as NodeJS.Timeout).unref();
      }
    });

    const result = await Promise.race([permissionPromise, timeoutPromise]);
    logger.debug('requestPermissionWithTimeout: completed', {
      result,
      elapsedMs: Date.now() - startTime,
    });
    return result;
  } catch (err) {
    logger.warn('requestPermissionWithTimeout: threw', {
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : 'Unknown',
    });
    return 'error';
  }
}

/**
 * Result from getLastRootHandleForRestore - includes the raw handle
 * so the UI can request permission synchronously in a click handler.
 */
export interface RestoreHandleResult {
  handle: FileSystemDirectoryHandle;
  folderId: string;
  name: string;
  permissionState: PermissionState | 'unknown';
}

export interface HandleCache {
  storeRootHandle(folderId: string, handle: FileSystemDirectoryHandle): Promise<void>;
  getRootHandle(folderId: string): Promise<FileSystemDirectoryHandle | null>;
  getAllRootHandles(): Promise<StoredRootHandle[]>;
  removeRootHandle(folderId: string): Promise<void>;
  restoreLastRootHandle(): Promise<{ handle: FileSystemDirectoryHandle } | null>;
  /**
   * Get the last root handle for restore, including permission state.
   * Does NOT request permission - the caller should do that synchronously
   * in a user gesture handler to ensure Chrome doesn't block it.
   */
  getLastRootHandleForRestore(): Promise<RestoreHandleResult | null>;
  /**
   * Mark a handle as successfully restored (updates lastAccessedAt).
   */
  markHandleRestored(folderId: string): Promise<void>;
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

  private canUseIndexedDb(): boolean {
    return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
  }

  private async getDb(): Promise<IDBPDatabase<HandleCacheSchema> | null> {
    if (!this.canUseIndexedDb()) {
      this.indexedDbAvailable = false;
      this.dbPromise = null;
      return null;
    }

    if (!this.indexedDbAvailable) {
      // IndexedDB might become available later (e.g. after hydration).
      this.indexedDbAvailable = true;
    }

    if (!this.dbPromise) {
      this.dbPromise = this.openDbWithRecovery();
    }

    try {
      return await this.dbPromise;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('getDb: failed to open database', { error: errorMessage });
      this.dbPromise = null;
      this.indexedDbAvailable = false;
      return null;
    }
  }

  /**
   * Opens the database with automatic recovery for corrupted/incomplete databases.
   * If the database exists but is missing required object stores, it will be deleted
   * and recreated.
   */
  private async openDbWithRecovery(): Promise<IDBPDatabase<HandleCacheSchema>> {
    const db = await openDB<HandleCacheSchema>(DB_NAME, DB_VERSION, {
      upgrade(upgradeDb) {
        logger.debug('openDbWithRecovery: running upgrade', {
          oldVersion: upgradeDb.version,
          stores: Array.from(upgradeDb.objectStoreNames),
        });
        if (!upgradeDb.objectStoreNames.contains(ROOT_STORE)) {
          const store = upgradeDb.createObjectStore(ROOT_STORE, { keyPath: 'folderId' });
          store.createIndex(ROOT_LAST_ACCESSED_INDEX, 'lastAccessedAt');
        }
        if (!upgradeDb.objectStoreNames.contains(FILE_STORE)) {
          const store = upgradeDb.createObjectStore(FILE_STORE, { keyPath: 'path' });
          store.createIndex(FILE_BY_FOLDER_INDEX, 'folderId');
        }
      },
    });

    // Verify the database has the required stores
    const hasRootStore = db.objectStoreNames.contains(ROOT_STORE);
    const hasFileStore = db.objectStoreNames.contains(FILE_STORE);

    if (!(hasRootStore && hasFileStore)) {
      logger.warn('openDbWithRecovery: database is missing required stores, recreating', {
        hasRootStore,
        hasFileStore,
        existingStores: Array.from(db.objectStoreNames),
      });

      // Close the corrupted database
      db.close();

      // Delete the corrupted database
      await new Promise<void>((resolve, reject) => {
        const deleteRequest = globalThis.indexedDB.deleteDatabase(DB_NAME);
        deleteRequest.onsuccess = () => resolve();
        deleteRequest.onerror = () => reject(deleteRequest.error);
        deleteRequest.onblocked = () => {
          logger.warn('openDbWithRecovery: database delete blocked');
          resolve(); // Continue anyway, will fail on next open if still blocked
        };
      });

      logger.info('openDbWithRecovery: deleted corrupted database, recreating');

      // Recreate with fresh stores
      return openDB<HandleCacheSchema>(DB_NAME, DB_VERSION, {
        upgrade(upgradeDb) {
          logger.debug('openDbWithRecovery: recreating stores after delete');
          const rootStore = upgradeDb.createObjectStore(ROOT_STORE, { keyPath: 'folderId' });
          rootStore.createIndex(ROOT_LAST_ACCESSED_INDEX, 'lastAccessedAt');
          const fileStore = upgradeDb.createObjectStore(FILE_STORE, { keyPath: 'path' });
          fileStore.createIndex(FILE_BY_FOLDER_INDEX, 'folderId');
        },
      });
    }

    logger.debug('openDbWithRecovery: database opened successfully', {
      stores: Array.from(db.objectStoreNames),
    });
    return db;
  }

  private buildFileKey(folderId: string, relativePath: string): string {
    return encodeFileSelection(folderId, relativePath);
  }

  private async updateRootRecord(record: StoredRootHandle): Promise<void> {
    this.memoryRootHandles.set(record.folderId, record);
    const db = await this.getDb();
    if (!db) {
      logger.debug('updateRootRecord: no db connection, storing in memory only');
      return;
    }
    try {
      await db.put(ROOT_STORE, record);
      logger.debug('updateRootRecord: stored to IndexedDB', { folderId: record.folderId });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('updateRootRecord: IndexedDB write failed, in-memory copy remains', {
        error: errorMessage,
        folderId: record.folderId,
      });
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
    logger.debug('storeRootHandle called', { folderId, handleName: handle.name });
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
    logger.debug('storeRootHandle completed', { folderId });
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
    logger.debug('getAllRootHandles called');
    const db = await this.getDb();
    logger.debug('getAllRootHandles: db connection', { hasDb: !!db });
    if (db) {
      try {
        const records = await db.getAll(ROOT_STORE);
        logger.debug('getAllRootHandles: fetched from IndexedDB', { count: records.length });
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
        const result = Array.from(merged.values());
        logger.debug('getAllRootHandles: returning merged results', { count: result.length });
        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorName = err instanceof Error ? err.name : 'Unknown';
        const errorStack = err instanceof Error ? err.stack : undefined;
        logger.warn('getAllRootHandles: IndexedDB fetch failed, falling back to memory', {
          errorName,
          error: errorMessage,
          stack: errorStack,
        });
      }
    }

    const memoryResult = Array.from(this.memoryRootHandles.values());
    logger.debug('getAllRootHandles: returning from memory only', { count: memoryResult.length });
    return memoryResult;
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
    logger.debug('restoreLastRootHandle called');
    const db = await this.getDb();
    let record: StoredRootHandle | null = null;

    if (db) {
      try {
        const index = db.transaction(ROOT_STORE).store.index(ROOT_LAST_ACCESSED_INDEX);
        const cursor = await index.openCursor(null, 'prev');
        record = cursor?.value ?? null;
        logger.debug('restoreLastRootHandle: fetched from IndexedDB', {
          hasRecord: !!record,
          folderId: record?.folderId,
        });
      } catch (err) {
        logger.warn('restoreLastRootHandle: IndexedDB fetch failed', { error: err });
        record = null;
      }
    }

    if (!record) {
      record =
        Array.from(this.memoryRootHandles.values()).sort(
          (a, b) => b.lastAccessedAt - a.lastAccessedAt
        )[0] ?? null;
      logger.debug('restoreLastRootHandle: fallback to memory', { hasRecord: !!record });
    }

    if (!(record && isDirectoryHandle(record.handle))) {
      logger.debug('restoreLastRootHandle: no valid record found');
      return null;
    }

    try {
      if (typeof record.handle.queryPermission === 'function') {
        const permission = await record.handle.queryPermission({ mode: 'read' });
        logger.debug('restoreLastRootHandle: permission query result', { permission });

        if (permission === 'granted') {
          await this.updateRootRecord({ ...record, lastAccessedAt: now() });
          logger.info('restoreLastRootHandle: permission already granted, returning handle');
          return { handle: record.handle };
        }
        if (permission === 'denied') {
          logger.debug('restoreLastRootHandle: permission denied');
          return null;
        }
        // Permission is 'prompt' - request it from user
        logger.debug('restoreLastRootHandle: requesting permission from user');
        const requested = await requestPermissionWithTimeout(record.handle);
        logger.debug('restoreLastRootHandle: requestPermission result', { requested });
        if (requested === 'timeout') {
          logger.warn('restoreLastRootHandle: permission request timed out');
          return null;
        }
        if (requested === 'error') {
          logger.warn('restoreLastRootHandle: permission request failed');
          return null;
        }
        if (requested === 'granted') {
          await this.updateRootRecord({ ...record, lastAccessedAt: now() });
          logger.info('restoreLastRootHandle: permission granted after request');
          return { handle: record.handle };
        }
        logger.debug('restoreLastRootHandle: permission not granted after request');
        return null;
      }

      await this.updateRootRecord({ ...record, lastAccessedAt: now() });
      logger.info('restoreLastRootHandle: no permission API, returning handle');
      return { handle: record.handle };
    } catch (err) {
      logger.warn('restoreLastRootHandle: error during permission check', { error: err });
      await this.removeRootHandle(record.folderId);
      return null;
    }
  }

  /**
   * Get the last root handle for restore without requesting permission.
   * Returns the raw handle so the UI can request permission synchronously
   * in a click handler (required by Chrome's user gesture detection).
   */
  async getLastRootHandleForRestore(): Promise<RestoreHandleResult | null> {
    logger.debug('getLastRootHandleForRestore called');
    const db = await this.getDb();
    let record: StoredRootHandle | null = null;

    if (db) {
      try {
        const index = db.transaction(ROOT_STORE).store.index(ROOT_LAST_ACCESSED_INDEX);
        const cursor = await index.openCursor(null, 'prev');
        record = cursor?.value ?? null;
        logger.debug('getLastRootHandleForRestore: fetched from IndexedDB', {
          hasRecord: !!record,
          folderId: record?.folderId,
        });
      } catch (err) {
        logger.warn('getLastRootHandleForRestore: IndexedDB fetch failed', { error: err });
        record = null;
      }
    }

    if (!record) {
      record =
        Array.from(this.memoryRootHandles.values()).sort(
          (a, b) => b.lastAccessedAt - a.lastAccessedAt
        )[0] ?? null;
      logger.debug('getLastRootHandleForRestore: fallback to memory', { hasRecord: !!record });
    }

    if (!(record && isDirectoryHandle(record.handle))) {
      logger.debug('getLastRootHandleForRestore: no valid record found');
      return null;
    }

    // Query permission state but DON'T request it - that must happen in UI click handler
    let permissionState: PermissionState | 'unknown' = 'unknown';
    if (typeof record.handle.queryPermission === 'function') {
      try {
        permissionState = await record.handle.queryPermission({ mode: 'read' });
        logger.debug('getLastRootHandleForRestore: permission query result', { permissionState });
      } catch (err) {
        logger.debug('getLastRootHandleForRestore: permission query failed', { error: err });
        permissionState = 'unknown';
      }
    }

    return {
      handle: record.handle,
      folderId: record.folderId,
      name: record.name,
      permissionState,
    };
  }

  /**
   * Mark a handle as successfully restored by updating its lastAccessedAt timestamp.
   */
  async markHandleRestored(folderId: string): Promise<void> {
    logger.debug('markHandleRestored called', { folderId });
    const record = this.memoryRootHandles.get(folderId);
    if (record) {
      await this.updateRootRecord({ ...record, lastAccessedAt: now() });
      logger.debug('markHandleRestored: updated from memory');
      return;
    }

    const db = await this.getDb();
    if (db) {
      try {
        const dbRecord = await db.get(ROOT_STORE, folderId);
        if (dbRecord) {
          await this.updateRootRecord({ ...dbRecord, lastAccessedAt: now() });
          logger.debug('markHandleRestored: updated from IndexedDB');
        }
      } catch (err) {
        logger.warn('markHandleRestored: failed to update', { error: err });
      }
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
