import { type EmbeddingStatus, SimpleEmbeddingService } from '@brainstrike/embeddings';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type ModelKey = string;

interface EmbeddingsPanelData {
  status: EmbeddingStatus;
  progress: number;
  progressMessage: string;
  selectedModel: ModelKey;
  text1: string;
  text2: string;
  similarity: number | null;
  selectedDevice: string | null;
  error: string | null;
}

interface EmbeddingsPanelActions {
  setSelectedModel: (k: ModelKey) => void;
  setText1: (v: string) => void;
  setText2: (v: string) => void;
  initialize: () => Promise<void>;
  calculateSimilarity: () => Promise<void>;
  dispose: () => Promise<void>;
}

type Store = EmbeddingsPanelData & EmbeddingsPanelActions;

const STORE_NAME = 'embeddings-panel.v1' as const;

// shared in-memory service instance (not persisted)
let service: SimpleEmbeddingService | null = null;

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

export const useEmbeddingsPanelStore = create<Store>()(
  persist(
    (set, get) => ({
      status: 'idle',
      progress: 0,
      progressMessage: '',
      selectedModel: SimpleEmbeddingService.getDefaultModelKey(),
      text1: 'Hello world, this is a test sentence.',
      text2: 'Hi there, this is another test phrase.',
      similarity: null,
      selectedDevice: null,
      error: null,

      setSelectedModel: (k) => set({ selectedModel: k, error: null }),
      setText1: (v) => set({ text1: v }),
      setText2: (v) => set({ text2: v }),

      initialize: async () => {
        if (!service) service = new SimpleEmbeddingService();
        const { selectedModel } = get();
        set({ status: 'initializing', error: null, progress: 0, progressMessage: '' });
        try {
          await service.initializeWithModel(selectedModel, (p) =>
            set({
              progress: p.progress || 0,
              progressMessage: p.message || '',
              status: p.stage === 'downloading' ? 'downloading' : get().status,
            })
          );
          set({ status: 'ready', progress: 100 });
          const cfg = service.getConfig();
          if (cfg?.selectedDevice) set({ selectedDevice: cfg.selectedDevice });
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Failed to initialize model';
          set({ status: 'error', error: msg });
        }
      },

      calculateSimilarity: async () => {
        const { status, text1, text2 } = get();
        if (!service || status !== 'ready' || !text1.trim() || !text2.trim()) return;
        try {
          set({ status: 'processing', error: null, similarity: null });
          const r1 = await service.generateEmbedding(text1.trim());
          const r2 = await service.generateEmbedding(text2.trim());
          const res = service.calculateSimilarity(r1.embedding, r2.embedding);
          set({ similarity: res.similarity, status: 'ready' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Failed to calculate similarity';
          set({ error: msg, status: 'ready' });
        }
      },

      dispose: async () => {
        try {
          await service?.dispose();
        } catch {}
        service = null;
        set({
          status: 'idle',
          similarity: null,
          progress: 0,
          progressMessage: '',
          error: null,
          selectedDevice: null,
        });
      },
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      // Persist only user-facing inputs and model selection
      partialize: (s) => ({ selectedModel: s.selectedModel, text1: s.text1, text2: s.text2 }),
      // Keep in-memory state for everything else on reload
    }
  )
);

// Test helper to reset state between tests
export function __resetEmbeddingsPanelStoreForTests() {
  try {
    service = null;
    useEmbeddingsPanelStore.setState({
      status: 'idle',
      progress: 0,
      progressMessage: '',
      selectedModel: SimpleEmbeddingService.getDefaultModelKey(),
      text1: 'Hello world, this is a test sentence.',
      text2: 'Hi there, this is another test phrase.',
      similarity: null,
      selectedDevice: null,
      error: null,
    });
    const persistApi = (
      useEmbeddingsPanelStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
