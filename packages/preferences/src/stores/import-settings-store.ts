import type { ChunkingStrategy } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

const DEFAULT_MODEL_KEY = SimpleEmbeddingService.getDefaultModelKey();

interface ImportSettingsData {
  enableChunking: boolean;
  chunkingStrategy: ChunkingStrategy;
  chunkSize: number;
  chunkOverlap: number;
  enableEmbedding: boolean;
  selectedModel: string;
}

interface ImportSettingsActions {
  setEnableChunking: (v: boolean) => void;
  setChunkingStrategy: (v: ChunkingStrategy) => void;
  setChunkSize: (n: number) => void;
  setChunkOverlap: (n: number) => void;
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
      chunkSize: 256,
      chunkOverlap: 50,
      enableEmbedding: false,
      selectedModel: DEFAULT_MODEL_KEY,

      setEnableChunking: (v) => set({ enableChunking: !!v }),
      setChunkingStrategy: (v) => set({ chunkingStrategy: v }),
      setChunkSize: (n) => set({ chunkSize: Math.max(1, Math.floor(n)) }),
      setChunkOverlap: (n) => set({ chunkOverlap: Math.max(0, Math.floor(n)) }),
      setEnableEmbedding: (v) => set({ enableEmbedding: !!v }),
      setSelectedModel: (k) => set({ selectedModel: k }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({
        enableChunking: s.enableChunking,
        chunkingStrategy: s.chunkingStrategy,
        chunkSize: s.chunkSize,
        chunkOverlap: s.chunkOverlap,
        enableEmbedding: s.enableEmbedding,
        selectedModel: s.selectedModel,
      }),
    }
  )
);

export const importSettingsSelectors = {
  chunking: (s: ImportSettingsStore) => [s.enableChunking, s.chunkingStrategy] as const,
  sizes: (s: ImportSettingsStore) => [s.chunkSize, s.chunkOverlap] as const,
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
    chunkSize: 256,
    chunkOverlap: 50,
    enableEmbedding: false,
    selectedModel: DEFAULT_MODEL_KEY,
  });
}
