import type { StateStorage } from 'zustand/middleware';

function readLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return;
  }
}

function removeStoredValue(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Best effort: blocked storage should not make cleanup flows fail.
  }
}

export function createBrowserJsonStorage(): StateStorage {
  const memory = new Map<string, string>();

  return {
    getItem: (key) => {
      const raw = readLocalStorage()?.getItem(key) ?? memory.get(key) ?? null;
      if (raw === null) {
        return null;
      }

      try {
        // Validation-only; Zustand's createJSONStorage parses the raw value.
        JSON.parse(raw);
        return raw;
      } catch {
        removeStoredValue(readLocalStorage(), key);
        memory.delete(key);
        return null;
      }
    },
    setItem: (key, value) => {
      const storage = readLocalStorage();
      if (storage) {
        try {
          storage.setItem(key, value);
          return;
        } catch {
          // Fall through to in-memory storage for quota/private-mode failures.
        }
      }
      memory.set(key, value);
    },
    removeItem: (key) => {
      removeStoredValue(readLocalStorage(), key);
      memory.delete(key);
    },
  };
}
