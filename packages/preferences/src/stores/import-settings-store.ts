import type { ChunkingStrategy } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

const DEFAULT_MODEL_KEY = SimpleEmbeddingService.getDefaultModelKey();

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

export const useImportSettingsStore = create<ImportSettingsStore>()(
  persist(
    (set) => ({
      enableChunking: true,
      chunkingStrategy: 'sentence',
      chunkingStrategyExplicit: false,
      chunkSize: 256,
      chunkOverlap: 50,
      tokenTrueSizing: true,
      chunkTokenLimit: 4096,
      enableEmbedding: false,
      selectedModel: DEFAULT_MODEL_KEY,

      setEnableChunking: (v) => set({ enableChunking: !!v }),
      setChunkingStrategy: (v) => set({ chunkingStrategy: v, chunkingStrategyExplicit: true }),
      setChunkSize: (n) => set({ chunkSize: Math.max(1, Math.floor(n)) }),
      setChunkOverlap: (n) => set({ chunkOverlap: Math.max(0, Math.floor(n)) }),
      setTokenTrueSizing: (v) => set({ tokenTrueSizing: !!v }),
      setChunkTokenLimit: (n) =>
        set({ chunkTokenLimit: Math.max(512, Math.min(16384, Math.floor(n) || 512)) }),
      setEnableEmbedding: (v) => set({ enableEmbedding: !!v }),
      setSelectedModel: (k) => set({ selectedModel: k }),
    }),
    {
      name: STORE_NAME,
      version: 2,
      storage,
      migrate: (state, version) => {
        const snapshot = state as Partial<ImportSettingsStore> | undefined;
        if (!snapshot) return snapshot;
        if (version < 2) {
          return {
            ...snapshot,
            tokenTrueSizing: true,
            chunkTokenLimit: 4096,
          } satisfies Partial<ImportSettingsStore>;
        }
        return {
          ...snapshot,
          tokenTrueSizing:
            typeof snapshot.tokenTrueSizing === 'boolean' ? snapshot.tokenTrueSizing : true,
          chunkTokenLimit:
            typeof snapshot.chunkTokenLimit === 'number'
              ? Math.max(512, Math.min(16384, Math.floor(snapshot.chunkTokenLimit)))
              : 4096,
        } satisfies Partial<ImportSettingsStore>;
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
    }
  )
);

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
  useImportSettingsStore.setState({
    enableChunking: true,
    chunkingStrategy: 'sentence',
    chunkingStrategyExplicit: false,
    chunkSize: 256,
    chunkOverlap: 50,
    tokenTrueSizing: true,
    chunkTokenLimit: 4096,
    enableEmbedding: false,
    selectedModel: DEFAULT_MODEL_KEY,
  });
}
