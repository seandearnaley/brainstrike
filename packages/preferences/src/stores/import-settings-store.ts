import type { ChunkingPresetSelection, ChunkingStrategy } from '@brainstrike/text-splitter';
import { getChunkingPreset } from '@brainstrike/text-splitter';
import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { useTokenPreferencesStore } from './token-preferences-store';

interface ImportSettingsData {
  chunkingPreset: ChunkingPresetSelection;
  chunkingStrategy: ChunkingStrategy;
  chunkingStrategyExplicit: boolean;
  chunkOverlap: number;
  chunkSize: number;
  chunkTokenLimit: number;
  enableChunking: boolean;
  tokenTrueSizing: boolean;
}

interface ImportSettingsActions {
  setChunkingPreset: (value: ChunkingPresetSelection) => void;
  setChunkingStrategy: (v: ChunkingStrategy) => void;
  setChunkOverlap: (n: number) => void;
  setChunkSize: (n: number) => void;
  setChunkTokenLimit: (n: number) => void;
  setEnableChunking: (v: boolean) => void;
  setTokenTrueSizing: (v: boolean) => void;
}

export type ImportSettingsStore = ImportSettingsData & ImportSettingsActions;

const STORE_NAME = 'import-settings.v1' as const;
const STORE_VERSION = 7 as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

const getAccurateCountingPreference = () => useTokenPreferencesStore.getState().accurateCounting;
const DEFAULT_CHUNKING_PRESET = getChunkingPreset('balanced');

export const useImportSettingsStore = create<ImportSettingsStore>()(
  persist(
    (set) => ({
      enableChunking: true,
      chunkingPreset: DEFAULT_CHUNKING_PRESET.id,
      chunkingStrategy: DEFAULT_CHUNKING_PRESET.strategy,
      chunkingStrategyExplicit: DEFAULT_CHUNKING_PRESET.strategy !== 'auto',
      chunkSize: DEFAULT_CHUNKING_PRESET.chunkSize,
      chunkOverlap: DEFAULT_CHUNKING_PRESET.chunkOverlap,
      tokenTrueSizing: getAccurateCountingPreference(),
      chunkTokenLimit: DEFAULT_CHUNKING_PRESET.tokenLimit,

      setEnableChunking: (v) => set({ enableChunking: !!v }),
      setChunkingPreset: (value) => {
        if (value === 'custom') {
          set({ chunkingPreset: 'custom' });
          return;
        }
        const preset = getChunkingPreset(value);
        set({
          chunkingPreset: preset.id,
          chunkingStrategy: preset.strategy,
          chunkingStrategyExplicit: preset.strategy !== 'auto',
          chunkSize: preset.chunkSize,
          chunkOverlap: preset.chunkOverlap,
          chunkTokenLimit: preset.tokenLimit,
        });
      },
      setChunkingStrategy: (v) =>
        set({
          chunkingPreset: 'custom',
          chunkingStrategy: v,
          chunkingStrategyExplicit: v !== 'auto',
        }),
      setChunkSize: (n) => set({ chunkingPreset: 'custom', chunkSize: Math.max(1, Math.floor(n)) }),
      setChunkOverlap: (n) =>
        set({ chunkingPreset: 'custom', chunkOverlap: Math.max(0, Math.floor(n)) }),
      setTokenTrueSizing: (v) => {
        const next = !!v;
        useTokenPreferencesStore.getState().setAccurateCounting(next);
        set({ tokenTrueSizing: next });
      },
      setChunkTokenLimit: (n) =>
        set({
          chunkingPreset: 'custom',
          chunkTokenLimit: Math.max(512, Math.min(16_384, Math.floor(n) || 512)),
        }),
    }),
    {
      name: STORE_NAME,
      version: STORE_VERSION,
      storage,
      migrate: (state, version) => {
        const snapshot = state as Partial<ImportSettingsStore> | undefined;
        if (!snapshot) {
          return snapshot;
        }
        let next: Partial<ImportSettingsStore> = { ...snapshot };
        if (version < 2) {
          next = {
            ...next,
            chunkingPreset:
              typeof next.chunkingPreset === 'string'
                ? next.chunkingPreset
                : DEFAULT_CHUNKING_PRESET.id,
            tokenTrueSizing: true,
            chunkTokenLimit: 4096,
          };
        } else {
          next = {
            ...next,
            chunkingPreset:
              typeof next.chunkingPreset === 'string'
                ? next.chunkingPreset
                : DEFAULT_CHUNKING_PRESET.id,
            tokenTrueSizing:
              typeof next.tokenTrueSizing === 'boolean' ? next.tokenTrueSizing : true,
            chunkTokenLimit:
              typeof next.chunkTokenLimit === 'number'
                ? Math.max(512, Math.min(16_384, Math.floor(next.chunkTokenLimit)))
                : 4096,
          };
        }
        if (version < 7 && next.chunkingPreset && next.chunkingPreset !== 'custom') {
          const preset = getChunkingPreset(next.chunkingPreset);
          next = {
            ...next,
            chunkingStrategy: preset.strategy,
            chunkingStrategyExplicit: preset.strategy !== 'auto',
            chunkSize: preset.chunkSize,
            chunkOverlap: preset.chunkOverlap,
            chunkTokenLimit: preset.tokenLimit,
          };
        }
        return next satisfies Partial<ImportSettingsStore>;
      },
      partialize: (s) => ({
        enableChunking: s.enableChunking,
        chunkingPreset: s.chunkingPreset,
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
    const persistApi = (
      useImportSettingsStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - storage errors should not fail test resets.
  }
  useTokenPreferencesStore.getState().setAccurateCounting(true);
  useImportSettingsStore.setState({
    enableChunking: true,
    chunkingPreset: DEFAULT_CHUNKING_PRESET.id,
    chunkingStrategy: DEFAULT_CHUNKING_PRESET.strategy,
    chunkingStrategyExplicit: false,
    chunkSize: DEFAULT_CHUNKING_PRESET.chunkSize,
    chunkOverlap: DEFAULT_CHUNKING_PRESET.chunkOverlap,
    tokenTrueSizing: true,
    chunkTokenLimit: DEFAULT_CHUNKING_PRESET.tokenLimit,
  });
}
