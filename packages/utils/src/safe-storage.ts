import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('SafeStorage');

/**
 * Error details for storage operations
 */
export interface StorageError {
  error: unknown;
  key: string;
  operation: 'get' | 'set' | 'remove' | 'clear' | 'key';
}

/**
 * Optional callback for handling storage errors
 */
export type StorageErrorHandler = (error: StorageError) => void;

export interface SafeJsonStorageAdapterOptions {
  errorHandler?: StorageErrorHandler;
  /**
   * When true, log JSON parse failures before clearing the key.
   * Defaults to true.
   */
  logParseErrors?: boolean;
}

/**
 * Creates a safe storage adapter with fallback to in-memory storage
 *
 * This utility wraps localStorage operations with proper error handling,
 * logging, and automatic fallback to in-memory storage when localStorage
 * is unavailable (SSR, privacy mode, quota exceeded, etc.)
 *
 * @param errorHandler Optional callback for custom error handling (e.g., showing toast notifications)
 * @returns Storage interface compatible with localStorage API
 *
 * @example
 * ```typescript
 * const storage = createSafeStorage((error) => {
 *   if (error.operation === 'set') {
 *     toast.error('Storage quota exceeded');
 *   }
 * });
 *
 * storage.setItem('key', 'value'); // Safely handles errors
 * ```
 */
export function createSafeStorage(errorHandler?: StorageErrorHandler): Storage {
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
        // Intentionally minimal logging for length check - not critical
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
        // Fall through to memory storage
      }
      memory.set(key, value);
    },
  };
}

/**
 * Creates a Zustand-compatible JSON storage adapter with safe error handling
 *
 * @param errorHandler Optional callback for custom error handling
 * @returns Object compatible with Zustand's createJSONStorage
 *
 * @example
 * ```typescript
 * const storage = createJSONStorage(() => createSafeStorageAdapter());
 *
 * const useStore = create(
 *   persist(
 *     (set) => ({ count: 0 }),
 *     { storage }
 *   )
 * );
 * ```
 */
export function createSafeStorageAdapter(errorHandler?: StorageErrorHandler) {
  const storage = createSafeStorage(errorHandler);

  return {
    getItem: (key: string) => storage.getItem(key),
    removeItem: (key: string) => storage.removeItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  };
}

/**
 * Creates a JSON-safe storage adapter for Zustand persistence.
 *
 * Ensures invalid JSON does not crash hydration by clearing corrupt entries
 * and returning null instead.
 */
export function createSafeJsonStorageAdapter(options: SafeJsonStorageAdapterOptions = {}) {
  const { errorHandler, logParseErrors = true } = options;
  const storage = createSafeStorage(errorHandler);

  return {
    getItem: (key: string): string | null => {
      const raw = storage.getItem(key);
      if (raw === null) {
        return null;
      }
      try {
        JSON.parse(raw);
        return raw;
      } catch (error) {
        if (logParseErrors) {
          logger.warn('Invalid JSON in storage; clearing key', { error, key });
        }
        errorHandler?.({ error, key, operation: 'get' });
        storage.removeItem(key);
        return null;
      }
    },
    removeItem: (key: string) => storage.removeItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  };
}
