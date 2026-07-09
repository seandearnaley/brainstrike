import { createLogger } from '@brainstrike/utils/logger';

/**
 * Minimal sync key/value interface compatible with Zustand's `createJSONStorage`
 * and with `Storage` itself.
 */
export interface SafeJsonStateStorage {
  getItem: (name: string) => string | null;
  removeItem: (name: string) => void;
  setItem: (name: string, value: string) => void;
}

/**
 * Error details for storage operations (utils-compatible shape).
 */
export interface StorageError {
  error: unknown;
  key: string;
  operation: 'get' | 'set' | 'remove' | 'clear' | 'key';
}

export type StorageErrorHandler = (error: StorageError) => void;

export type PersistenceMode = 'memory' | 'persistent';
export type PersistenceStorageArea = 'localStorage';
export type PersistenceStorageOperation = 'get' | 'remove' | 'set';

export interface PersistenceIssue {
  readonly error: unknown;
  readonly key: string;
  readonly mode: PersistenceMode;
  readonly operation: PersistenceStorageOperation;
  readonly storageArea: PersistenceStorageArea;
}

export interface SafeJsonStateStorageOptions {
  /** Utils-compatible storage error listener. */
  readonly errorHandler?: StorageErrorHandler;
  /**
   * When true, log JSON parse failures before clearing the key.
   * Defaults to true.
   */
  readonly logParseErrors?: boolean;
  /**
   * Optional read-time hook. If it returns valid JSON, that value is persisted under
   * `name` and returned. Used by tab-manager-store to perform a one-time migration
   * from a legacy localStorage key.
   */
  readonly migrateOnGet?: (name: string) => string | null;
  /** Preferences-compatible persistence issue listener. */
  readonly onPersistenceIssue?: (issue: PersistenceIssue) => void;
  /** Logger scope used for write/remove/parse failure warnings. Defaults to 'SafeStorage'. */
  readonly scope?: string;
}

export type BrowserJsonStorageOptions = Pick<SafeJsonStateStorageOptions, 'onPersistenceIssue'>;

export type SafeJsonStorageAdapterOptions = Pick<
  SafeJsonStateStorageOptions,
  'errorHandler' | 'logParseErrors'
>;

interface LocalStorageAccess {
  readonly error?: unknown;
  readonly storage?: Storage;
}

function readLocalStorage(): LocalStorageAccess {
  try {
    if (typeof localStorage === 'undefined') {
      return {};
    }
    return { storage: localStorage };
  } catch (error) {
    return { error };
  }
}

function resolvePersistenceMode(operation: PersistenceStorageOperation): PersistenceMode {
  return operation === 'remove' ? 'persistent' : 'memory';
}

function notifyListeners(
  options: SafeJsonStateStorageOptions,
  operation: PersistenceStorageOperation,
  key: string,
  error: unknown
): void {
  const storageErrorOperation: StorageError['operation'] = operation;
  try {
    options.errorHandler?.({ error, key, operation: storageErrorOperation });
  } catch {
    // Listener failures must not break the storage fallback path.
  }

  const listener = options.onPersistenceIssue;
  if (!listener) {
    return;
  }
  try {
    listener({
      error,
      key,
      mode: resolvePersistenceMode(operation),
      operation,
      storageArea: 'localStorage',
    });
  } catch {
    // Listener failures must not break the storage fallback path.
  }
}

/**
 * Creates a safe storage adapter with fallback to in-memory storage.
 *
 * Wraps localStorage with error handling, logging, and automatic fallback when
 * localStorage is unavailable (SSR, privacy mode, quota exceeded, etc.).
 */
export function createSafeStorage(errorHandler?: StorageErrorHandler): Storage {
  const logger = createLogger('SafeStorage');
  const memory = new Map<string, string>();

  return {
    clear(): void {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.clear();
          return;
        }
      } catch (error) {
        logger.error('localStorage.clear() failed, clearing in-memory storage:', error);
        errorHandler?.({ error, key: '*', operation: 'clear' });
      }
      memory.clear();
    },
    getItem(key: string): string | null {
      try {
        if (typeof localStorage !== 'undefined') {
          return localStorage.getItem(key);
        }
      } catch (error) {
        logger.warn(`localStorage.getItem("${key}") failed, using in-memory fallback:`, error);
        errorHandler?.({ error, key, operation: 'get' });
      }
      return memory.get(key) ?? null;
    },

    key(index: number): string | null {
      try {
        if (typeof localStorage !== 'undefined') {
          return localStorage.key(index);
        }
      } catch (error) {
        logger.warn(`localStorage.key(${index}) failed, using in-memory fallback:`, error);
        errorHandler?.({ error, key: String(index), operation: 'key' });
      }
      return Array.from(memory.keys())[index] ?? null;
    },

    get length(): number {
      try {
        if (typeof localStorage !== 'undefined') {
          return localStorage.length;
        }
      } catch (error) {
        logger.debug('localStorage.length failed, using in-memory fallback:', error);
      }
      return memory.size;
    },

    removeItem(key: string): void {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(key);
          return;
        }
      } catch (error) {
        logger.warn(`localStorage.removeItem("${key}") failed, using in-memory fallback:`, error);
        errorHandler?.({ error, key, operation: 'remove' });
      }
      memory.delete(key);
    },

    setItem(key: string, value: string): void {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(key, value);
          return;
        }
      } catch (error) {
        logger.error(`localStorage.setItem("${key}") failed, using in-memory fallback:`, error);
        errorHandler?.({ error, key, operation: 'set' });
      }
      memory.set(key, value);
    },
  };
}

/**
 * Creates a Zustand-compatible storage adapter with safe error handling.
 */
export function createSafeStorageAdapter(errorHandler?: StorageErrorHandler): SafeJsonStateStorage {
  const storage = createSafeStorage(errorHandler);

  return {
    getItem: (key: string) => storage.getItem(key),
    removeItem: (key: string) => storage.removeItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  };
}

/**
 * Build a safe localStorage-with-in-memory-fallback JSON state storage.
 *
 * localStorage failures are reported via optional listeners and the value is held
 * in memory for the rest of the session. Invalid JSON is cleared so hydration
 * self-heals. Designed for Zustand's `createJSONStorage`.
 */
export function createSafeJsonStateStorage(
  options: SafeJsonStateStorageOptions = {}
): SafeJsonStateStorage {
  const {
    scope = 'SafeStorage',
    migrateOnGet,
    logParseErrors = true,
    onPersistenceIssue,
    errorHandler,
  } = options;
  const listenerOptions: SafeJsonStateStorageOptions = {
    ...(errorHandler ? { errorHandler } : {}),
    ...(onPersistenceIssue ? { onPersistenceIssue } : {}),
  };
  const logger = createLogger(scope);
  const memory = new Map<string, string>();

  const removeLocalStorage = (key: string): void => {
    const { error: storageAccessError, storage } = readLocalStorage();
    if (storageAccessError !== undefined) {
      notifyListeners(listenerOptions, 'remove', key, storageAccessError);
    }
    try {
      storage?.removeItem(key);
    } catch (error) {
      logger.warn('localStorage.removeItem failed', {
        error: error instanceof Error ? error.message : String(error),
        key,
      });
      notifyListeners(listenerOptions, 'remove', key, error);
    }
  };

  const writeLocalStorage = (key: string, value: string): boolean => {
    const { error: storageAccessError, storage } = readLocalStorage();
    if (storageAccessError !== undefined) {
      notifyListeners(listenerOptions, 'set', key, storageAccessError);
    }
    if (!storage) {
      return false;
    }
    try {
      storage.setItem(key, value);
      return true;
    } catch (error) {
      logger.warn('localStorage.setItem failed; falling back to in-memory storage', {
        error: error instanceof Error ? error.message : String(error),
        key,
      });
      notifyListeners(listenerOptions, 'set', key, error);
      return false;
    }
  };

  /**
   * Verify a candidate string parses as JSON before handing it to Zustand. If parsing
   * fails we clear the bad value so the store self-heals on the next session.
   */
  const validateOrEvictJson = (name: string, value: string): string | null => {
    try {
      JSON.parse(value);
      return value;
    } catch (error) {
      if (logParseErrors) {
        logger.warn('Corrupted JSON in localStorage; clearing key for self-heal', {
          error: error instanceof Error ? error.message : String(error),
          key: name,
        });
      }
      notifyListeners(listenerOptions, 'get', name, error);
      removeLocalStorage(name);
      memory.delete(name);
      return null;
    }
  };

  return {
    getItem: (name: string) => {
      const { error: storageAccessError, storage } = readLocalStorage();
      if (storageAccessError !== undefined) {
        notifyListeners(listenerOptions, 'get', name, storageAccessError);
      }

      let direct: string | null | undefined;
      try {
        direct = storage?.getItem(name);
      } catch (error) {
        notifyListeners(listenerOptions, 'get', name, error);
        direct = undefined;
      }

      if (direct !== null && direct !== undefined) {
        // The current key existed (even if corrupted). validateOrEvictJson clears the
        // bad entry on failure, so the next load will see "missing" and run the
        // migration cleanly. Returning null here — rather than falling through to
        // `migrateOnGet` — prevents silently restoring legacy data over what the user
        // last had under the current key.
        return validateOrEvictJson(name, direct);
      }

      const migrated = migrateOnGet?.(name);
      if (migrated !== null && migrated !== undefined) {
        const validated = validateOrEvictJson(name, migrated);
        if (validated !== null) {
          const persisted = writeLocalStorage(name, validated);
          if (!persisted) {
            memory.set(name, validated);
          }
          return validated;
        }
      }

      const fromMemory = memory.get(name);
      if (fromMemory !== undefined) {
        return validateOrEvictJson(name, fromMemory);
      }
      return null;
    },
    removeItem: (name: string) => {
      removeLocalStorage(name);
      memory.delete(name);
    },
    setItem: (name: string, value: string) => {
      const persisted = writeLocalStorage(name, value);
      if (!persisted) {
        memory.set(name, value);
      }
    },
  };
}

/**
 * JSON-safe storage adapter for Zustand persistence (utils-compatible entrypoint).
 * Ensures invalid JSON does not crash hydration by clearing corrupt entries.
 */
export function createSafeJsonStorageAdapter(
  options: SafeJsonStorageAdapterOptions = {}
): SafeJsonStateStorage {
  return createSafeJsonStateStorage({
    scope: 'SafeStorage',
    ...(options.errorHandler ? { errorHandler: options.errorHandler } : {}),
    ...(options.logParseErrors === undefined ? {} : { logParseErrors: options.logParseErrors }),
  });
}

/**
 * Preferences-compatible browser JSON storage entrypoint.
 * Parse failures are cleared silently (no log) unless a listener is provided.
 */
export function createBrowserJsonStorage(
  options: BrowserJsonStorageOptions = {}
): SafeJsonStateStorage {
  return createSafeJsonStateStorage({
    logParseErrors: false,
    scope: 'BrowserJsonStorage',
    ...(options.onPersistenceIssue ? { onPersistenceIssue: options.onPersistenceIssue } : {}),
  });
}
