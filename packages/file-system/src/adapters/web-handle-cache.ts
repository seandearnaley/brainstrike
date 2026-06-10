import { createLogger, encodeFileSelection } from '@brainstrike/utils';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

const logger = createLogger('WebHandleCache');

// Keep this name in sync with factory-reset fallback IndexedDB list.
const DB_NAME = 'brainstrike-file-handles' as const;
const DB_VERSION = 2 as const;

const ROOT_STORE = 'root-handles' as const;
const FILE_STORE = 'file-handles' as const;
const ROOT_LAST_ACCESSED_INDEX = 'by-last-accessed' as const;
const FILE_BY_FOLDER_INDEX = 'by-folder' as const;

const DEFAULT_MAX_AGE_MS = 2_592_000_000; // 30 days in ms (1000 * 60 * 60 * 24 * 30)

const now = () => Date.now();

export interface StoredRootHandle {
  /**
   * Opaque RootId supplied by the caller (since v2). Generated once via
   * crypto.randomUUID() when the root is first added and stable across
   * sessions. Not derived from the directory name — names collide.
   * The `name` field holds the human-readable directory name.
   */
  folderId: string;
  handle: FileSystemDirectoryHandle;
  lastAccessedAt: number;
  /** Human-readable display name (the directory's name property). */
  name: string;
  storedAt: number;
}

export interface StoredFileHandle {
  folderId: string;
  handle: FileSystemFileHandle;
  name: string;
  path: string;
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

/**
 * Type guard for FileSystemDirectoryHandle.
 * Validates both property existence and that methods are actually functions.
 */
const isDirectoryHandle = (handle: unknown): handle is FileSystemDirectoryHandle => {
  if (!handle || typeof handle !== 'object') {
    return false;
  }
  const candidate = handle as Record<string, unknown>;
  return (
    candidate['kind'] === 'directory' &&
    typeof candidate['name'] === 'string' &&
    'entries' in candidate &&
    typeof candidate['entries'] === 'function'
  );
};

/**
 * Type guard for FileSystemFileHandle.
 * Validates both property existence and that methods are actually functions.
 */
const isFileHandle = (handle: unknown): handle is FileSystemFileHandle => {
  if (!handle || typeof handle !== 'object') {
    return false;
  }
  const candidate = handle as Record<string, unknown>;
  return (
    candidate['kind'] === 'file' &&
    typeof candidate['name'] === 'string' &&
    'getFile' in candidate &&
    typeof candidate['getFile'] === 'function'
  );
};

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
    // Preserve full error context for debugging while returning a simple status
    const errorInfo =
      err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack }
        : { message: String(err), name: 'Unknown', stack: undefined };
    logger.warn('requestPermissionWithTimeout: threw', errorInfo);
    return 'error';
  }
}

/**
 * Result from getLastRootHandleForRestore - includes the raw handle
 * so the UI can request permission synchronously in a click handler.
 */
export interface RestoreHandleResult {
  folderId: string;
  handle: FileSystemDirectoryHandle;
  name: string;
  permissionState: PermissionState | 'unknown';
}

export interface HandleCache {
  clear(): Promise<void>;
  getAllRootHandles(): Promise<StoredRootHandle[]>;
  getFileHandle(folderId: string, relativePath: string): Promise<FileSystemFileHandle | null>;
  /**
   * Get the last root handle for restore, including permission state.
   * Does NOT request permission - the caller should do that synchronously
   * in a user gesture handler to ensure Chrome doesn't block it.
   */
  getLastRootHandleForRestore(): Promise<RestoreHandleResult | null>;
  getRootHandle(folderId: string): Promise<FileSystemDirectoryHandle | null>;
  /**
   * Mark a handle as successfully restored (updates lastAccessedAt).
   */
  markHandleRestored(folderId: string): Promise<void>;
  pruneOldHandles(maxAge?: number): Promise<void>;
  removeFileHandle(folderId: string, relativePath: string): Promise<void>;
  removeRootHandle(folderId: string): Promise<void>;
  restoreLastRootHandle(): Promise<{ handle: FileSystemDirectoryHandle } | null>;
  storeFileHandle(
    folderId: string,
    relativePath: string,
    handle: FileSystemFileHandle
  ): Promise<void>;
  storeRootHandle(folderId: string, handle: FileSystemDirectoryHandle): Promise<void>;
}

// LRU cache configuration
const MAX_ROOT_HANDLES = 10;
const MAX_FILE_HANDLES = 100;

/**
 * WebHandleCache - Two-tier caching for File System Access API handles.
 *
 * This cache uses a two-tier strategy:
 * 1. **IndexedDB (primary)**: Persists handles across browser sessions. IndexedDB can store
 *    FileSystemDirectoryHandle and FileSystemFileHandle objects directly.
 * 2. **In-memory (fallback)**: Used when IndexedDB is unavailable or fails. Handles are lost
 *    on page reload but the app remains functional within a session.
 *
 * Features:
 * - LRU eviction: Limits stored handles to prevent unbounded growth (10 roots, 100 files)
 * - Automatic recovery: Detects and recreates corrupted IndexedDB databases
 * - Permission-aware: Tracks permission state without requesting (Chrome gesture requirement)
 * - TTL-based pruning: Removes handles older than 30 days via pruneOldHandles()
 */
/**
 * Delay before retrying after IndexedDB open failure to prevent retry storms.
 * 5 seconds is chosen as a balance between:
 * - Being long enough to prevent rapid retry loops on persistent failures
 * - Being short enough to recover quickly if IndexedDB becomes available
 * Common failure scenarios: quota exceeded, private browsing mode, corrupted DB.
 */
const DB_RETRY_DELAY_MS = 5000;

export class WebHandleCache implements HandleCache {
  /**
   * Cached promise for the IndexedDB connection.
   * Using a single promise field eliminates race conditions - all concurrent
   * getDb() calls will await the same promise.
   */
  private dbPromise: Promise<IDBPDatabase<HandleCacheSchema> | null> | null = null;
  private indexedDbAvailable =
    typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
  private readonly memoryRootHandles = new Map<string, StoredRootHandle>();
  private readonly memoryFileHandles = new Map<string, StoredFileHandle>();

  /** Timestamp of last DB open failure - prevents retry storms */
  private lastDbFailureTime = 0;

  private canUseIndexedDb(): boolean {
    return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
  }

  /**
   * Evict oldest entries from a Map to maintain size limit (LRU eviction).
   * Entries are ordered by insertion time in Map, so we delete from the beginning.
   */
  private evictOldest<K, V>(map: Map<K, V>, maxSize: number): void {
    while (map.size > maxSize) {
      const firstKey = map.keys().next().value;
      if (firstKey === undefined) {
        break;
      }
      map.delete(firstKey);
    }
  }

  private async getDb(): Promise<IDBPDatabase<HandleCacheSchema> | null> {
    if (!this.canUseIndexedDb()) {
      this.indexedDbAvailable = false;
      this.dbPromise = null;
      return null;
    }

    // Prevent retry storms: if we failed recently, don't retry yet
    if (!this.indexedDbAvailable) {
      const timeSinceFailure = now() - this.lastDbFailureTime;
      if (timeSinceFailure < DB_RETRY_DELAY_MS) {
        logger.debug('getDb: skipping retry, cooling down', {
          timeSinceFailure,
          retryDelayMs: DB_RETRY_DELAY_MS,
        });
        return null;
      }
      // Cooldown period passed, allow retry
      this.indexedDbAvailable = true;
    }

    // Single promise pattern: all concurrent calls share the same promise.
    // No busy-wait needed - if dbPromise exists, we just await it.
    if (!this.dbPromise) {
      this.dbPromise = this.openDbWithRecovery().catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn('getDb: failed to open database', { error: errorMessage });
        this.dbPromise = null;
        this.indexedDbAvailable = false;
        this.lastDbFailureTime = now();
        return null;
      });
    }

    return this.dbPromise;
  }

  /**
   * Opens the database with automatic recovery for corrupted/incomplete databases.
   * If the database exists but is missing required object stores, it will be deleted
   * and recreated.
   */
  private async openDbWithRecovery(): Promise<IDBPDatabase<HandleCacheSchema>> {
    const db = await openDB<HandleCacheSchema>(DB_NAME, DB_VERSION, {
      blocked() {
        logger.warn('openDbWithRecovery: v2 upgrade blocked by an open connection in another tab');
      },
      upgrade(upgradeDb, oldVersion, _newVersion, transaction) {
        logger.debug('openDbWithRecovery: running upgrade', {
          oldVersion,
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
        if (oldVersion === 1) {
          // GREENFIELD: v1 keyed roots by handle.name (same-named directories
          // collided). No back-compat burden — discard v1 data wholesale; the
          // user re-picks folders once. clear() requests queue synchronously
          // inside the upgrade transaction (real Chrome auto-commits the txn
          // at the first non-IDB await, so never use detached async here).
          transaction.objectStore(ROOT_STORE).clear();
          transaction.objectStore(FILE_STORE).clear();
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
        blocked() {
          logger.warn(
            'openDbWithRecovery: v2 upgrade blocked by an open connection in another tab'
          );
        },
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

  /**
   * Verify a directory handle is still valid by checking if queryPermission works.
   * Returns true if valid, false if the handle is stale/invalid.
   */
  private async isHandleValid(handle: FileSystemDirectoryHandle): Promise<boolean> {
    try {
      await handle.queryPermission?.({ mode: 'read' });
      return true;
    } catch {
      return false;
    }
  }

  private async updateRootRecord(record: StoredRootHandle): Promise<void> {
    // LRU eviction: delete old key first to re-insert at end (Map maintains insertion order)
    this.memoryRootHandles.delete(record.folderId);
    this.memoryRootHandles.set(record.folderId, record);
    this.evictOldest(this.memoryRootHandles, MAX_ROOT_HANDLES);

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
    // LRU eviction: delete old key first to re-insert at end (Map maintains insertion order)
    this.memoryFileHandles.delete(record.path);
    this.memoryFileHandles.set(record.path, record);
    this.evictOldest(this.memoryFileHandles, MAX_FILE_HANDLES);

    const db = await this.getDb();
    if (!db) {
      logger.debug('updateFileRecord: no db connection, storing in memory only');
      return;
    }
    try {
      await db.put(FILE_STORE, record);
      logger.debug('updateFileRecord: stored to IndexedDB', { path: record.path });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('updateFileRecord: IndexedDB write failed, in-memory copy remains', {
        error: errorMessage,
        path: record.path,
      });
    }
  }

  /**
   * Store a root directory handle in the cache.
   * Updates the lastAccessedAt timestamp if the handle already exists.
   *
   * @param folderId - Opaque RootId supplied by the caller (since v2). Must be
   *   a crypto.randomUUID()-generated string — never derived from the directory
   *   name, which is not unique across roots.
   * @param handle - The FileSystemDirectoryHandle to store
   */
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

  /**
   * Retrieve a root directory handle from the cache.
   * Validates the handle is still accessible and updates lastAccessedAt on success.
   * Automatically removes stale handles that are no longer valid.
   *
   * @param folderId - Opaque RootId (since v2) identifying the root
   * @returns The directory handle if found and valid, null otherwise
   */
  async getRootHandle(folderId: string): Promise<FileSystemDirectoryHandle | null> {
    const record = await this.fetchRootRecord(folderId);
    if (!record) {
      return null;
    }
    if (!isDirectoryHandle(record.handle)) {
      return null;
    }

    // Verify handle is still valid before returning
    const isValid = await this.isHandleValid(record.handle);
    if (!isValid) {
      logger.warn('getRootHandle: handle no longer valid, removing', { folderId });
      await this.removeRootHandle(folderId);
      return null;
    }

    const updated: StoredRootHandle = { ...record, lastAccessedAt: now() };
    await this.updateRootRecord(updated);
    return updated.handle;
  }

  /**
   * Fetch a root record from IndexedDB or memory cache.
   */
  private async fetchRootRecord(folderId: string): Promise<StoredRootHandle | null> {
    const db = await this.getDb();
    if (db) {
      try {
        const record = await db.get(ROOT_STORE, folderId);
        if (record) {
          return record;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.debug('fetchRootRecord: IndexedDB fetch failed, falling back to memory', {
          folderId,
          error: errorMessage,
        });
      }
    }
    return this.memoryRootHandles.get(folderId) ?? null;
  }

  /**
   * Get all stored root directory handles.
   * Merges IndexedDB and in-memory caches to return a complete list.
   *
   * @returns Array of all stored root handles with metadata
   */
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

  /**
   * Remove a root directory handle and all associated file handles.
   *
   * @param folderId - Unique identifier for the folder to remove
   */
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
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('removeRootHandle: IndexedDB delete failed', {
        folderId,
        error: errorMessage,
      });
    }
  }

  /**
   * Restore the most recently accessed root handle with automatic permission handling.
   * Finds the handle with the latest lastAccessedAt timestamp and requests permission
   * if needed. Updates the timestamp on successful restore.
   *
   * @returns Object containing the handle if restore succeeds, null otherwise
   */
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

  /**
   * Store a file handle in the cache, associated with a root folder.
   *
   * @param folderId - The root folder this file belongs to
   * @param relativePath - Path relative to the root folder
   * @param handle - The FileSystemFileHandle to store
   */
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

  /**
   * Retrieve a file handle from the cache.
   *
   * @param folderId - The root folder this file belongs to
   * @param relativePath - Path relative to the root folder
   * @returns The file handle if found, null otherwise
   */
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
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.debug('getFileHandle: IndexedDB fetch failed, falling back to memory', {
          path,
          error: errorMessage,
        });
      }
    }

    const fallback = this.memoryFileHandles.get(path);
    if (fallback && isFileHandle(fallback.handle)) {
      return fallback.handle;
    }
    return null;
  }

  /**
   * Remove a file handle from the cache.
   *
   * @param folderId - The root folder this file belongs to
   * @param relativePath - Path relative to the root folder
   */
  async removeFileHandle(folderId: string, relativePath: string): Promise<void> {
    const path = this.buildFileKey(folderId, relativePath);
    this.memoryFileHandles.delete(path);

    const db = await this.getDb();
    if (!db) {
      return;
    }
    try {
      await db.delete(FILE_STORE, path);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('removeFileHandle: IndexedDB delete failed', {
        path,
        error: errorMessage,
      });
    }
  }

  /**
   * Clear all stored handles from both IndexedDB and in-memory cache.
   */
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
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('clear: IndexedDB clear failed', { error: errorMessage });
    }
  }

  /**
   * Remove handles older than the specified age.
   * Called automatically on adapter initialization and can be called manually.
   *
   * @param maxAge - Maximum age in milliseconds (default: 30 days)
   */
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
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn('pruneOldHandles: IndexedDB prune failed', { error: errorMessage });
    }
  }
}
