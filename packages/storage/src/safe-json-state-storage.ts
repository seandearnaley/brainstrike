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
   * Optional pre-write hook. If it returns a non-null string, that value is stored under
   * `name` instead of the original `value`. Used by tab-manager-store to perform a
   * one-time migration from a legacy localStorage key.
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

  const fromLocalStorage = (key: string): string | null => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(key);
      }
    } catch {
      // SSR or sandbox without localStorage; fall back silently — log on writes only.
    }
    return null;
  };

  const writeLocalStorage = (key: string, value: string): boolean => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
        return true;
      }
    } catch (err) {
      logger.warn('localStorage.setItem failed; falling back to in-memory storage', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  };

  const removeLocalStorage = (key: string): void => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    } catch (err) {
      logger.warn('localStorage.removeItem failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    getItem: (name: string) => {
      const direct = fromLocalStorage(name);
      if (direct !== null) {
        return direct;
      }
      const migrated = migrateOnGet?.(name);
      if (migrated !== null && migrated !== undefined) {
        return migrated;
      }
      return memory.get(name) ?? null;
    },
    setItem: (name: string, value: string) => {
      const persisted = writeLocalStorage(name, value);
      if (!persisted) {
        memory.set(name, value);
      }
    },
    removeItem: (name: string) => {
      removeLocalStorage(name);
      memory.delete(name);
    },
  };
}
