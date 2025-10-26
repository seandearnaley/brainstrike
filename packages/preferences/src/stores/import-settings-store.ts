import type { ChunkingStrategy } from '@brainstrike/db';
import {
  type EmbeddingProviderType,
  formatProviderModelKey,
  parseProviderModelKey,
  SimpleEmbeddingService,
} from '@brainstrike/embeddings';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { useEmbeddingPreferencesStore } from './embedding-preferences-store';
import { useTokenPreferencesStore } from './token-preferences-store';

const DEFAULT_MODEL_KEY = SimpleEmbeddingService.getDefaultModelKey();
const DEFAULT_PROVIDER: EmbeddingProviderType = 'local';

interface ImportSettingsData {
  enableChunking: boolean;
  chunkingStrategy: ChunkingStrategy;
  chunkingStrategyExplicit: boolean;
  chunkSize: number;
  chunkOverlap: number;
  tokenTrueSizing: boolean;
  chunkTokenLimit: number;
  enableEmbedding: boolean;
  selectedModel: string;
}

interface ImportSettingsActions {
  setEnableChunking: (v: boolean) => void;
  setChunkingStrategy: (v: ChunkingStrategy) => void;
  setChunkSize: (n: number) => void;
  setChunkOverlap: (n: number) => void;
  setTokenTrueSizing: (v: boolean) => void;
  setChunkTokenLimit: (n: number) => void;
  setEnableEmbedding: (v: boolean) => void;
  setSelectedModel: (k: string) => void;
}

export type ImportSettingsStore = ImportSettingsData & ImportSettingsActions;

const STORE_NAME = 'import-settings.v1' as const;
const STORE_VERSION = 3 as const;

const memory = new Map<string, string>();
const storage = createJSONStorage(() => ({
  getItem: (k: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(k);
    } catch {}
    return memory.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.setItem(k, v);
    } catch {}
    memory.set(k, v);
  },
  removeItem: (k: string) => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.removeItem(k);
    } catch {}
    memory.delete(k);
  },
}));

const getAccurateCountingPreference = () => useTokenPreferencesStore.getState().accurateCounting;

function normalizeModelSelection(value: string | null | undefined): {
  modelId: string;
  provider: EmbeddingProviderType;
} {
  const parsed = parseProviderModelKey(value ?? undefined);
  if (parsed) {
    return parsed;
  }
  const fallback =
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_MODEL_KEY;
  return { modelId: fallback, provider: DEFAULT_PROVIDER };
}

function deriveInitialSelectedModel(): string {
  try {
    const fromPrefs = useEmbeddingPreferencesStore.getState().selectedModel;
    return normalizeModelSelection(fromPrefs).modelId;
  } catch {
    return DEFAULT_MODEL_KEY;
  }
}

function formatCompositeKey(provider: EmbeddingProviderType, modelId: string): string {
  return formatProviderModelKey(provider, modelId);
}

let syncingFromPreferences = false;
let syncingToPreferences = false;

function syncPreferencesSelection(provider: EmbeddingProviderType, modelId: string): void {
  if (syncingFromPreferences) {
    return;
  }
  try {
    const composite = formatCompositeKey(provider, modelId);
    const prefs = useEmbeddingPreferencesStore.getState();
    const alreadyEnabled = prefs.getEnabledModels(provider)?.includes(modelId);
    if (!alreadyEnabled) {
      prefs.setModelEnabled(provider, modelId, true);
    }
    if (prefs.selectedModel === composite) {
      return;
    }
    syncingToPreferences = true;
    prefs.setModel(composite);
  } catch {
    // ignore preference sync failures (tests without store, etc.)
  } finally {
    syncingToPreferences = false;
  }
}

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
      enableEmbedding: false,
      selectedModel: deriveInitialSelectedModel(),

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
      setEnableEmbedding: (v) => set({ enableEmbedding: !!v }),
      setSelectedModel: (k) => {
        const { modelId, provider } = normalizeModelSelection(k);
        set({ selectedModel: modelId });
        syncPreferencesSelection(provider, modelId);
      },
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
        if (version < 3) {
          next = {
            ...next,
            selectedModel: normalizeModelSelection(next.selectedModel).modelId,
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
        enableEmbedding: s.enableEmbedding,
        selectedModel: s.selectedModel,
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
  embedding: (s: ImportSettingsStore) => [s.enableEmbedding, s.selectedModel] as const,
};

// Test-only helper to avoid cross-test persistence
export function __resetImportSettingsStoreForTests() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_NAME);
  } catch {}
  memory.delete(STORE_NAME);
  useTokenPreferencesStore.getState().setAccurateCounting(true);
  useImportSettingsStore.setState({
    enableChunking: true,
    chunkingStrategy: 'sentence',
    chunkingStrategyExplicit: false,
    chunkSize: 256,
    chunkOverlap: 50,
    tokenTrueSizing: true,
    chunkTokenLimit: 4096,
    enableEmbedding: false,
    selectedModel: normalizeModelSelection(DEFAULT_MODEL_KEY).modelId,
  });
}

try {
  useEmbeddingPreferencesStore.subscribe((state, previousState) => {
    if (syncingToPreferences) {
      return;
    }
    const nextModel = normalizeModelSelection(state.selectedModel).modelId;
    const prevModel = normalizeModelSelection(previousState?.selectedModel).modelId;
    if (nextModel === prevModel) {
      return;
    }
    if (useImportSettingsStore.getState().selectedModel === nextModel) {
      return;
    }
    syncingFromPreferences = true;
    useImportSettingsStore.setState({ selectedModel: nextModel });
    syncingFromPreferences = false;
  });
} catch {
  // Ignore subscription failures (e.g., during SSR tests without preference store)
}
