import { createSafeStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

type VectorStatusUIData = {
  activeEmbeddingSetId: string | null;
  /** When true, live queries should be paused to avoid performance degradation during bulk operations */
  isImporting: boolean;
  /** When true, embeddings are actively being generated (from any source). */
  isEmbeddingActive: boolean;
  /** When true, the local embedding queue adapter is processing tasks. */
  isEmbeddingQueueActive: boolean;
  /** When true, the job_queue has embedding work pending (queued/running). */
  isJobQueueActive: boolean;
};

type VectorStatusUIActions = {
  setActiveEmbeddingSetId: (id: string | null) => void;
  setIsImporting: (importing: boolean) => void;
  setIsEmbeddingQueueActive: (active: boolean) => void;
  setIsJobQueueActive: (active: boolean) => void;
};

export type VectorStatusUIStore = VectorStatusUIData & VectorStatusUIActions;

const STORE_NAME = 'vector-status-ui.v1' as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeStorageAdapter());

export const useVectorStatusUIStore = create<VectorStatusUIStore>()(
  persist(
    (set) => ({
      activeEmbeddingSetId: null,
      isImporting: false,
      isEmbeddingActive: false,
      isEmbeddingQueueActive: false,
      isJobQueueActive: false,
      setActiveEmbeddingSetId: (id) => set({ activeEmbeddingSetId: id }),
      setIsImporting: (importing) => set({ isImporting: importing }),
      setIsEmbeddingQueueActive: (active) =>
        set((state) => ({
          isEmbeddingQueueActive: active,
          isEmbeddingActive: active || state.isJobQueueActive,
        })),
      setIsJobQueueActive: (active) =>
        set((state) => ({
          isJobQueueActive: active,
          isEmbeddingActive: state.isEmbeddingQueueActive || active,
        })),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      // Only persist activeEmbeddingSetId - import/embedding flags are transient state
      partialize: (s) => ({ activeEmbeddingSetId: s.activeEmbeddingSetId }),
    }
  )
);

export const vectorStatusUISelectors = {
  activeSet: (s: VectorStatusUIStore) => s.activeEmbeddingSetId,
  isImporting: (s: VectorStatusUIStore) => s.isImporting,
  isEmbeddingActive: (s: VectorStatusUIStore) => s.isEmbeddingActive,
  isEmbeddingQueueActive: (s: VectorStatusUIStore) => s.isEmbeddingQueueActive,
  isJobQueueActive: (s: VectorStatusUIStore) => s.isJobQueueActive,
};

export function __resetVectorStatusUIStoreForTests() {
  try {
    const persistApi = (
      useVectorStatusUIStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - storage errors should not fail test resets.
  }
  useVectorStatusUIStore.setState({
    activeEmbeddingSetId: null,
    isImporting: false,
    isEmbeddingActive: false,
    isEmbeddingQueueActive: false,
    isJobQueueActive: false,
  });
}
