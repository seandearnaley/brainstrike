import type { StateStorage } from 'zustand/middleware';

export type PersistenceMode = 'memory' | 'persistent';
export type PersistenceStorageArea = 'localStorage';
export type PersistenceStorageOperation = 'get' | 'remove' | 'set';

export interface PersistenceIssue {
  readonly error: unknown;
  readonly key: string;
  readonly mode: Extract<PersistenceMode, 'memory'>;
  readonly operation: PersistenceStorageOperation;
  readonly storageArea: PersistenceStorageArea;
}

export interface BrowserJsonStorageOptions {
  readonly onPersistenceIssue?: (issue: PersistenceIssue) => void;
}

interface LocalStorageAccess {
  readonly error?: unknown;
  readonly storage?: Storage;
}

function readLocalStorage(): LocalStorageAccess {
  try {
    if (typeof window === 'undefined') {
      return {};
    }
    return { storage: window.localStorage };
  } catch (error) {
    return { error };
  }
}

function notifyPersistenceIssue(
  options: BrowserJsonStorageOptions,
  operation: PersistenceStorageOperation,
  key: string,
  error: unknown
): void {
  options.onPersistenceIssue?.({
    error,
    key,
    mode: 'memory',
    operation,
    storageArea: 'localStorage',
  });
}

function removeStoredValue(
  storage: Storage | undefined,
  key: string,
  options: BrowserJsonStorageOptions
): void {
  try {
    storage?.removeItem(key);
  } catch (error) {
    notifyPersistenceIssue(options, 'remove', key, error);
  }
}

export function createBrowserJsonStorage(options: BrowserJsonStorageOptions = {}): StateStorage {
  const memory = new Map<string, string>();

  return {
    getItem: (key) => {
      const { error: storageAccessError, storage } = readLocalStorage();
      if (storageAccessError !== undefined) {
        notifyPersistenceIssue(options, 'get', key, storageAccessError);
      }

      let localStorageValue: string | null | undefined;
      try {
        localStorageValue = storage?.getItem(key);
      } catch (error) {
        notifyPersistenceIssue(options, 'get', key, error);
      }

      const raw = localStorageValue ?? memory.get(key) ?? null;
      if (raw === null) {
        return null;
      }

      try {
        // Validation-only; Zustand's createJSONStorage parses the raw value.
        JSON.parse(raw);
        return raw;
      } catch {
        removeStoredValue(storage, key, options);
        memory.delete(key);
        return null;
      }
    },
    setItem: (key, value) => {
      const { error: storageAccessError, storage } = readLocalStorage();
      if (storageAccessError !== undefined) {
        notifyPersistenceIssue(options, 'set', key, storageAccessError);
      }

      if (storage) {
        try {
          storage.setItem(key, value);
          return;
        } catch (error) {
          notifyPersistenceIssue(options, 'set', key, error);
        }
      }
      memory.set(key, value);
    },
    removeItem: (key) => {
      const { error: storageAccessError, storage } = readLocalStorage();
      if (storageAccessError !== undefined) {
        notifyPersistenceIssue(options, 'remove', key, storageAccessError);
      }
      removeStoredValue(storage, key, options);
      memory.delete(key);
    },
  };
}
