import { createSafeStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface VectorStatusUIData {
  activeEmbeddingSetId: string | null;
}

interface VectorStatusUIActions {
  setActiveEmbeddingSetId: (id: string | null) => void;
}

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
      setActiveEmbeddingSetId: (id) => set({ activeEmbeddingSetId: id }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({ activeEmbeddingSetId: s.activeEmbeddingSetId }),
    }
  )
);

export const vectorStatusUISelectors = {
  activeSet: (s: VectorStatusUIStore) => s.activeEmbeddingSetId,
};

export function __resetVectorStatusUIStoreForTests() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_NAME);
  } catch (error) {
    console.warn('[Test] Failed to remove storage in test reset:', error);
  }
  useVectorStatusUIStore.setState({ activeEmbeddingSetId: null });
}
