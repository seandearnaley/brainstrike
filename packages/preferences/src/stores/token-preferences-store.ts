import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface TokenPreferencesData {
  accurateCounting: boolean;
}

interface TokenPreferencesActions {
  setAccurateCounting: (enabled: boolean) => void;
}

export type TokenPreferencesStore = TokenPreferencesData & TokenPreferencesActions;

const STORE_NAME = 'token-preferences.v1' as const;

const memory = new Map<string, string>();
const storage = createJSONStorage(() => ({
  getItem: (key: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(key);
      }
    } catch {
      // ignore storage access errors (e.g., SSR, sandbox restrictions)
    }
    return memory.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.setItem(key, value);
      }
    } catch {
      // ignore storage access errors
    }
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.removeItem(key);
      }
    } catch {
      // ignore storage access errors
    }
    memory.delete(key);
  },
}));

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
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORE_NAME);
    }
  } catch {
    // ignore storage access errors during tests
  }
  memory.delete(STORE_NAME);
  useTokenPreferencesStore.setState({ accurateCounting: true });
}
