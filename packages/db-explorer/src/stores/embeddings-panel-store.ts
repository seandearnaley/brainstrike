import {
  type EmbeddingStatus,
  type ModelConfig,
  SimpleEmbeddingService,
} from '@brainstrike/embeddings';
import { createLogger, createSafeJsonStorageAdapter } from '@brainstrike/utils';
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
  initialize: (modelConfig: ModelConfig) => Promise<void>;
  calculateSimilarity: () => Promise<void>;
  dispose: () => Promise<void>;
}

type Store = EmbeddingsPanelData & EmbeddingsPanelActions;

const STORE_NAME = 'embeddings-panel.v1' as const;
const logger = createLogger('EmbeddingsPanelStore');

// shared in-memory service instance (not persisted)
let service: SimpleEmbeddingService | null = null;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

export const useEmbeddingsPanelStore = create<Store>()(
  persist(
    (set, get) => ({
      status: 'idle',
      progress: 0,
      progressMessage: '',
      selectedModel: '',
      text1: 'Hello world, this is a test sentence.',
      text2: 'Hi there, this is another test phrase.',
      similarity: null,
      selectedDevice: null,
      error: null,

      setSelectedModel: (k) => set({ selectedModel: k, error: null }),
      setText1: (v) => set({ text1: v }),
      setText2: (v) => set({ text2: v }),

      initialize: async (modelConfig) => {
        if (!service) {
          service = new SimpleEmbeddingService();
        }
        set({ status: 'initializing', error: null, progress: 0, progressMessage: '' });
        try {
          await service.initializeWithModel(modelConfig, (p) =>
            set({
              progress: p.progress || 0,
              progressMessage: p.message || '',
              status: p.stage === 'downloading' ? 'downloading' : get().status,
            })
          );
          set({ status: 'ready', progress: 100 });
          const cfg = service.getConfig();
          if (cfg?.selectedDevice) {
            set({ selectedDevice: cfg.selectedDevice });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Failed to initialize model';
          set({ status: 'error', error: msg });
        }
      },

      calculateSimilarity: async () => {
        const { status, text1, text2 } = get();
        if (!service || status !== 'ready' || !text1.trim() || !text2.trim()) {
          return;
        }
        try {
          set({ status: 'processing', error: null, similarity: null });
          const svcAny = service as unknown as {
            generateQueryEmbedding?: (t: string) => Promise<{ embedding: number[] }>;
            generateEmbedding: (t: string) => Promise<{ embedding: number[] }>;
          };
          const r1 = svcAny.generateQueryEmbedding
            ? await svcAny.generateQueryEmbedding(text1.trim())
            : await service.generateEmbedding(text1.trim());
          const r2 = svcAny.generateQueryEmbedding
            ? await svcAny.generateQueryEmbedding(text2.trim())
            : await service.generateEmbedding(text2.trim());
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
        } catch (error) {
          logger.warn('Failed to dispose embeddings service', { error });
        }
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
      selectedModel: '',
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
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset.
    // This prevents test failures when localStorage is unavailable.
  }
}
