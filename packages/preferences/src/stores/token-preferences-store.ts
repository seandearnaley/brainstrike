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

function createTokenPreferencesStorage(): StateStorage {
  const memory = new Map<string, string>();

  return {
    getItem: (key) => {
      try {
        return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem: (key, value) => {
      try {
        window.localStorage.setItem(key, value);
        return;
      } catch {
        memory.set(key, value);
      }
    },
    removeItem: (key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Keep the in-memory cleanup below as the fallback path.
      }
      memory.delete(key);
    },
  };
}

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createTokenPreferencesStorage());

export const useTokenPreferencesStore = create<TokenPreferencesStore>()(
  persist(
    (set) => ({
      accurateCounting: true,
      setAccurateCounting: (enabled) => set({ accurateCounting: !!enabled }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
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
      partialize: (store) => ({
        accurateCounting: store.accurateCounting,
      }),
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
