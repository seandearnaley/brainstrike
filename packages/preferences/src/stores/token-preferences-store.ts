import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface TokenPreferencesData {
  accurateCounting: boolean;
}

interface TokenPreferencesActions {
  setAccurateCounting: (enabled: boolean) => void;
}

export type TokenPreferencesStore = TokenPreferencesData & TokenPreferencesActions;

const STORE_NAME = 'token-preferences.v1' as const;

function readLocalStorage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
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

function createTokenPreferencesStorage(): StateStorage {
  const memory = new Map<string, string>();

  const shouldPersistValue = (value: string): boolean => {
    try {
      const parsed = JSON.parse(value) as { state?: { accurateCounting?: unknown } };
      return parsed.state?.accurateCounting === false;
    } catch {
      return true;
    }
  };

  return {
    getItem: (key) => {
      const storage = readLocalStorage();
      const raw = storage?.getItem(key) ?? memory.get(key) ?? null;
      if (raw === null) {
        return null;
      }

      try {
        JSON.parse(raw);
        return raw;
      } catch {
        removeStoredValue(storage, key);
        memory.delete(key);
        return null;
      }
    },
    removeItem: (key) => {
      removeStoredValue(readLocalStorage(), key);
      memory.delete(key);
    },
    setItem: (key, value) => {
      if (!shouldPersistValue(value)) {
        removeStoredValue(readLocalStorage(), key);
        memory.delete(key);
        return;
      }
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
  };
}

const storage = createJSONStorage(() => createTokenPreferencesStorage());

export const useTokenPreferencesStore = create<TokenPreferencesStore>()(
  persist(
    (set) => ({
      accurateCounting: true,
      setAccurateCounting: (enabled) => set({ accurateCounting: !!enabled }),
    }),
    {
      migrate: (state) => {
        const snapshot = state as Partial<TokenPreferencesStore> | undefined;
        if (!snapshot) {
          return snapshot;
        }

        return {
          ...snapshot,
          accurateCounting:
            typeof snapshot.accurateCounting === 'boolean' ? snapshot.accurateCounting : true,
        } satisfies Partial<TokenPreferencesStore>;
      },
      name: STORE_NAME,
      partialize: (store) => ({
        accurateCounting: store.accurateCounting,
      }),
      storage,
      version: 1,
    }
  )
);

export const tokenPreferencesSelectors = {
  accurateCounting: (store: TokenPreferencesStore) => store.accurateCounting,
};

// Test-only helper to reset state between suites
export function __resetTokenPreferencesStoreForTests() {
  try {
    const persistApi = (
      useTokenPreferencesStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - storage errors should not fail test resets.
  }
  useTokenPreferencesStore.setState({ accurateCounting: true });
}
