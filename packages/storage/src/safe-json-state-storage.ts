import { createLogger } from '@brainstrike/utils/logger';

/**
 * A minimal sync key/value interface compatible with Zustand's `createJSONStorage` and
 * with `Storage` itself. Returning strings (or null) keeps both legacy and Zustand-style
 * persisters happy.
 */
export interface SafeJsonStateStorage {
  getItem: (name: string) => string | null;
  removeItem: (name: string) => void;
  setItem: (name: string, value: string) => void;
}

interface CreateOptions {
  /**
   * Optional read-time hook. If it returns valid JSON, that value is persisted under
   * `name` and returned. Used by tab-manager-store to perform a one-time migration
   * from a legacy localStorage key.
   */
  readonly migrateOnGet?: (name: string) => string | null;
  /** Logger scope used for write/remove failure warnings. */
  readonly scope: string;
}

/**
 * Build a safe localStorage-with-in-memory-fallback state storage. localStorage failures
 * (private browsing, quota exceeded, etc.) are logged once at warn level and the value
 * is held in memory for the rest of the session — so the current session keeps working
 * even when persistence is unavailable. Designed for Zustand's `createJSONStorage`.
 */
export function createSafeJsonStateStorage(options: CreateOptions): SafeJsonStateStorage {
  const { scope, migrateOnGet } = options;
  const logger = createLogger(scope);
  const memory = new Map<string, string>();
  // Whether localStorage is reachable in this environment. The answer is fixed for the
  // lifetime of the storage instance (SSR/jsdom sandboxes can't gain localStorage
  // mid-session), so check once instead of on every accessor call.
  const hasLocalStorage = typeof localStorage !== 'undefined';

  const fromLocalStorage = (key: string): string | null => {
    if (!hasLocalStorage) {
      return null;
    }
    try {
      return localStorage.getItem(key);
    } catch {
      // Sandbox or revoked-permission edge case; log on writes only.
      return null;
    }
  };

  const writeLocalStorage = (key: string, value: string): boolean => {
    if (!hasLocalStorage) {
      return false;
    }
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      logger.warn('localStorage.setItem failed; falling back to in-memory storage', {
        error: err instanceof Error ? err.message : String(err),
        key,
      });
      return false;
    }
  };

  const removeLocalStorage = (key: string): void => {
    if (!hasLocalStorage) {
      return;
    }
    try {
      localStorage.removeItem(key);
    } catch (err) {
      logger.warn('localStorage.removeItem failed', {
        error: err instanceof Error ? err.message : String(err),
        key,
      });
    }
  };

  /**
   * Verify a candidate string parses as JSON before handing it to Zustand. If parsing
   * fails (corrupted entry from a partial write, manual DevTools edit, etc.) we clear
   * the bad value so the store self-heals on the next session — without this, the
   * corrupted entry would fail JSON.parse on every page load until manually cleared.
   */
  const validateOrEvictJson = (name: string, value: string): string | null => {
    try {
      JSON.parse(value);
      return value;
    } catch (err) {
      logger.warn('Corrupted JSON in localStorage; clearing key for self-heal', {
        error: err instanceof Error ? err.message : String(err),
        key: name,
      });
      removeLocalStorage(name);
      memory.delete(name);
      return null;
    }
  };

  return {
    getItem: (name: string) => {
      const direct = fromLocalStorage(name);
      if (direct !== null) {
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
