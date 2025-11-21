import { createSafeStorageAdapter } from '@brainstrike/utils';
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

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeStorageAdapter());

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
  } catch (error) {
    console.warn('[Test] Failed to remove storage in test reset:', error);
  }
  useTokenPreferencesStore.setState({ accurateCounting: true });
}
