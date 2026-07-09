import {
  type ChunkingPresetSelection,
  type ChunkingStrategy,
  getChunkingPreset,
  isChunkingStrategy,
} from '@brainstrike/indexing-contract';
import { createBrowserJsonStorage } from '@brainstrike/storage';
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
 */
const storage = createJSONStorage(() => createBrowserJsonStorage());

const getAccurateCountingPreference = () => useTokenPreferencesStore.getState().accurateCounting;
const DEFAULT_CHUNKING_PRESET = getChunkingPreset('balanced');

function normalizePersistedNumericSetting(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePersistedChunkingStrategy(value: unknown): ChunkingStrategy | null {
  return isChunkingStrategy(value) ? value : null;
}

function applyBaseMigrationDefaults(
  snapshot: Partial<ImportSettingsStore>,
  version: number
): Partial<ImportSettingsStore> {
  if (version < 2) {
    return {
      ...snapshot,
      chunkingPreset:
        typeof snapshot.chunkingPreset === 'string'
          ? snapshot.chunkingPreset
          : DEFAULT_CHUNKING_PRESET.id,
      chunkTokenLimit: 4096,
      tokenTrueSizing: true,
    };
  }

  return {
    ...snapshot,
    chunkingPreset:
      typeof snapshot.chunkingPreset === 'string'
        ? snapshot.chunkingPreset
        : DEFAULT_CHUNKING_PRESET.id,
    chunkTokenLimit:
      typeof snapshot.chunkTokenLimit === 'number'
        ? Math.max(512, Math.min(16_384, Math.floor(snapshot.chunkTokenLimit)))
        : 4096,
    tokenTrueSizing:
      typeof snapshot.tokenTrueSizing === 'boolean' ? snapshot.tokenTrueSizing : true,
  };
}

function migrateLegacyPresetState(
  snapshot: Partial<ImportSettingsStore>,
  next: Partial<ImportSettingsStore>,
  version: number
): Partial<ImportSettingsStore> {
  if (version >= 7 || !next.chunkingPreset || next.chunkingPreset === 'custom') {
    return next;
  }

  const preset = getChunkingPreset(next.chunkingPreset);
  const normalizedStrategy =
    normalizePersistedChunkingStrategy(next.chunkingStrategy) ?? preset.strategy;
  const normalizedChunkSize =
    normalizePersistedNumericSetting(next.chunkSize, 1, Number.MAX_SAFE_INTEGER) ??
    preset.chunkSize;
  const normalizedChunkOverlap =
    normalizePersistedNumericSetting(next.chunkOverlap, 0, Number.MAX_SAFE_INTEGER) ??
    preset.chunkOverlap;
  const normalizedChunkTokenLimit =
    normalizePersistedNumericSetting(next.chunkTokenLimit, 512, 16_384) ?? preset.tokenLimit;
  const hadExplicitPreset = typeof snapshot.chunkingPreset === 'string';
  const shouldPromoteLegacySnapshotToCustom =
    !hadExplicitPreset &&
    (normalizedStrategy !== preset.strategy ||
      normalizedChunkSize !== preset.chunkSize ||
      normalizedChunkOverlap !== preset.chunkOverlap ||
      normalizedChunkTokenLimit !== preset.tokenLimit);

  return {
    ...next,
    chunkingPreset: shouldPromoteLegacySnapshotToCustom ? 'custom' : preset.id,
    chunkingStrategy: normalizedStrategy,
    chunkingStrategyExplicit:
      typeof next.chunkingStrategyExplicit === 'boolean'
        ? next.chunkingStrategyExplicit
        : normalizedStrategy !== 'auto',
    chunkOverlap: normalizedChunkOverlap,
    chunkSize: normalizedChunkSize,
    chunkTokenLimit: normalizedChunkTokenLimit,
  };
}

export const useImportSettingsStore = create<ImportSettingsStore>()(
  persist(
    (set) => ({
      chunkingPreset: DEFAULT_CHUNKING_PRESET.id,
      chunkingStrategy: DEFAULT_CHUNKING_PRESET.strategy,
      chunkingStrategyExplicit: DEFAULT_CHUNKING_PRESET.strategy !== 'auto',
      chunkOverlap: DEFAULT_CHUNKING_PRESET.chunkOverlap,
      chunkSize: DEFAULT_CHUNKING_PRESET.chunkSize,
      chunkTokenLimit: DEFAULT_CHUNKING_PRESET.tokenLimit,
      enableChunking: true,
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
          chunkOverlap: preset.chunkOverlap,
          chunkSize: preset.chunkSize,
          chunkTokenLimit: preset.tokenLimit,
        });
      },
      setChunkingStrategy: (v) =>
        set({
          chunkingPreset: 'custom',
          chunkingStrategy: v,
          chunkingStrategyExplicit: true,
        }),
      setChunkOverlap: (n) =>
        set({ chunkingPreset: 'custom', chunkOverlap: Math.max(0, Math.floor(n)) }),
      setChunkSize: (n) => set({ chunkingPreset: 'custom', chunkSize: Math.max(1, Math.floor(n)) }),
      setChunkTokenLimit: (n) =>
        set({
          chunkingPreset: 'custom',
          chunkTokenLimit: Math.max(512, Math.min(16_384, Math.floor(n) || 512)),
        }),

      setEnableChunking: (v) => set({ enableChunking: !!v }),
      setTokenTrueSizing: (v) => {
        const next = !!v;
        useTokenPreferencesStore.getState().setAccurateCounting(next);
        set({ tokenTrueSizing: next });
      },
      tokenTrueSizing: getAccurateCountingPreference(),
    }),
    {
      migrate: (state, version) => {
        const snapshot = state as Partial<ImportSettingsStore> | undefined;
        if (!snapshot) {
          return snapshot;
        }
        const next = migrateLegacyPresetState(
          snapshot,
          applyBaseMigrationDefaults(snapshot, version),
          version
        );
        return next satisfies Partial<ImportSettingsStore>;
      },
      name: STORE_NAME,
      onRehydrateStorage: () => (state) => {
        if (state && typeof state.tokenTrueSizing === 'boolean') {
          useTokenPreferencesStore.getState().setAccurateCounting(state.tokenTrueSizing);
        }
      },
      partialize: (s) => ({
        chunkingPreset: s.chunkingPreset,
        chunkingStrategy: s.chunkingStrategy,
        chunkingStrategyExplicit: s.chunkingStrategyExplicit,
        chunkOverlap: s.chunkOverlap,
        chunkSize: s.chunkSize,
        chunkTokenLimit: s.chunkTokenLimit,
        enableChunking: s.enableChunking,
        tokenTrueSizing: s.tokenTrueSizing,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

function bindTokenPreferencesSync(): () => void {
  return useTokenPreferencesStore.subscribe((preferences) => {
    const current = useImportSettingsStore.getState().tokenTrueSizing;
    if (current !== preferences.accurateCounting) {
      useImportSettingsStore.setState({ tokenTrueSizing: preferences.accurateCounting });
    }
  });
}

// Module-scoped subscription is intentional: this store is a singleton in app/runtime code.
// Tests explicitly reset and rebind it to avoid cross-test leakage.
let unsubscribeTokenPreferencesSync = bindTokenPreferencesSync();

export const importSettingsSelectors = {
  chunking: (s: ImportSettingsStore) => [s.enableChunking, s.chunkingStrategy] as const,
  sizes: (s: ImportSettingsStore) => [s.chunkSize, s.chunkOverlap] as const,
  tokenLimit: (s: ImportSettingsStore) => s.chunkTokenLimit,
  tokenSizing: (s: ImportSettingsStore) => s.tokenTrueSizing,
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
    chunkingPreset: DEFAULT_CHUNKING_PRESET.id,
    chunkingStrategy: DEFAULT_CHUNKING_PRESET.strategy,
    chunkingStrategyExplicit: false,
    chunkOverlap: DEFAULT_CHUNKING_PRESET.chunkOverlap,
    chunkSize: DEFAULT_CHUNKING_PRESET.chunkSize,
    chunkTokenLimit: DEFAULT_CHUNKING_PRESET.tokenLimit,
    enableChunking: true,
    tokenTrueSizing: true,
  });
  unsubscribeTokenPreferencesSync();
  unsubscribeTokenPreferencesSync = bindTokenPreferencesSync();
}
