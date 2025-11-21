import type { ChunkingStrategy } from '@brainstrike/db';
import { createSafeStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { useTokenPreferencesStore } from './token-preferences-store';

interface ImportSettingsData {
  enableChunking: boolean;
  chunkingStrategy: ChunkingStrategy;
  chunkingStrategyExplicit: boolean;
  chunkSize: number;
  chunkOverlap: number;
  tokenTrueSizing: boolean;
  chunkTokenLimit: number;
}

interface ImportSettingsActions {
  setEnableChunking: (v: boolean) => void;
  setChunkingStrategy: (v: ChunkingStrategy) => void;
  setChunkSize: (n: number) => void;
  setChunkOverlap: (n: number) => void;
  setTokenTrueSizing: (v: boolean) => void;
  setChunkTokenLimit: (n: number) => void;
}

export type ImportSettingsStore = ImportSettingsData & ImportSettingsActions;

const STORE_NAME = 'import-settings.v1' as const;
const STORE_VERSION = 5 as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeStorageAdapter());

const getAccurateCountingPreference = () => useTokenPreferencesStore.getState().accurateCounting;

export const useImportSettingsStore = create<ImportSettingsStore>()(
  persist(
    (set) => ({
      enableChunking: true,
      chunkingStrategy: 'sentence',
      chunkingStrategyExplicit: false,
      chunkSize: 256,
      chunkOverlap: 50,
      tokenTrueSizing: getAccurateCountingPreference(),
      chunkTokenLimit: 4096,

      setEnableChunking: (v) => set({ enableChunking: !!v }),
      setChunkingStrategy: (v) => set({ chunkingStrategy: v, chunkingStrategyExplicit: true }),
      setChunkSize: (n) => set({ chunkSize: Math.max(1, Math.floor(n)) }),
      setChunkOverlap: (n) => set({ chunkOverlap: Math.max(0, Math.floor(n)) }),
      setTokenTrueSizing: (v) => {
        const next = !!v;
        useTokenPreferencesStore.getState().setAccurateCounting(next);
        set({ tokenTrueSizing: next });
      },
      setChunkTokenLimit: (n) =>
        set({ chunkTokenLimit: Math.max(512, Math.min(16384, Math.floor(n) || 512)) }),
    }),
    {
      name: STORE_NAME,
      version: STORE_VERSION,
      storage,
      migrate: (state, version) => {
        const snapshot = state as Partial<ImportSettingsStore> | undefined;
        if (!snapshot) return snapshot;
        let next: Partial<ImportSettingsStore> = { ...snapshot };
        if (version < 2) {
          next = {
            ...next,
            tokenTrueSizing: true,
            chunkTokenLimit: 4096,
          };
        } else {
          next = {
            ...next,
            tokenTrueSizing:
              typeof next.tokenTrueSizing === 'boolean' ? next.tokenTrueSizing : true,
            chunkTokenLimit:
              typeof next.chunkTokenLimit === 'number'
                ? Math.max(512, Math.min(16384, Math.floor(next.chunkTokenLimit)))
                : 4096,
          };
        }
        return next satisfies Partial<ImportSettingsStore>;
      },
      partialize: (s) => ({
        enableChunking: s.enableChunking,
        chunkingStrategy: s.chunkingStrategy,
        chunkingStrategyExplicit: s.chunkingStrategyExplicit,
        chunkSize: s.chunkSize,
        chunkOverlap: s.chunkOverlap,
        tokenTrueSizing: s.tokenTrueSizing,
        chunkTokenLimit: s.chunkTokenLimit,
      }),
      onRehydrateStorage: () => (state) => {
        if (state && typeof state.tokenTrueSizing === 'boolean') {
          useTokenPreferencesStore.getState().setAccurateCounting(state.tokenTrueSizing);
        }
      },
    }
  )
);

useTokenPreferencesStore.subscribe((preferences) => {
  const current = useImportSettingsStore.getState().tokenTrueSizing;
  if (current !== preferences.accurateCounting) {
    useImportSettingsStore.setState({ tokenTrueSizing: preferences.accurateCounting });
  }
});

export const importSettingsSelectors = {
  chunking: (s: ImportSettingsStore) => [s.enableChunking, s.chunkingStrategy] as const,
  sizes: (s: ImportSettingsStore) => [s.chunkSize, s.chunkOverlap] as const,
  tokenSizing: (s: ImportSettingsStore) => s.tokenTrueSizing,
  tokenLimit: (s: ImportSettingsStore) => s.chunkTokenLimit,
};

// Test-only helper to avoid cross-test persistence
export function __resetImportSettingsStoreForTests() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_NAME);
  } catch (error) {
    console.warn('[Test] Failed to remove storage in test reset:', error);
  }
  const persistApi = (
    useImportSettingsStore as unknown as {
      persist?: { clearStorage?: () => void };
    }
  ).persist;
  persistApi?.clearStorage?.();
  useTokenPreferencesStore.getState().setAccurateCounting(true);
  useImportSettingsStore.setState({
    enableChunking: true,
    chunkingStrategy: 'sentence',
    chunkingStrategyExplicit: false,
    chunkSize: 256,
    chunkOverlap: 50,
    tokenTrueSizing: true,
    chunkTokenLimit: 4096,
  });
}
