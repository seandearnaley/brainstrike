import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge.ts';

interface TokenPreferencesData {
  accurateCounting: boolean;
}

interface TokenPreferencesActions {
  setAccurateCounting: (enabled: boolean) => void;
}

export type TokenPreferencesStore = TokenPreferencesData & TokenPreferencesActions;

const STORE_NAME = 'brainstrike:token-preferences.v1' as const;

function sanitizePersistedData(state: unknown): TokenPreferencesData {
  const snapshot =
    state && typeof state === 'object' ? (state as Partial<TokenPreferencesData>) : {};
  return {
    accurateCounting:
      typeof snapshot.accurateCounting === 'boolean' ? snapshot.accurateCounting : true,
  };
}

export const useTokenPreferencesStore = create<TokenPreferencesStore>()(
  persistDurable(
    STORE_NAME,
    (set) => ({
      accurateCounting: true,
      setAccurateCounting: (enabled) => set({ accurateCounting: !!enabled }),
    }),
    {
      merge: createSanitizedPersistMerge<TokenPreferencesStore, TokenPreferencesData>(
        sanitizePersistedData
      ),
      migrate: sanitizePersistedData,
      partialize: (store) => ({
        accurateCounting: store.accurateCounting,
      }),
      version: 1,
    }
  )
);

export const tokenPreferencesSelectors = {
  accurateCounting: (store: TokenPreferencesStore) => store.accurateCounting,
};
