import { createSafeStorageAdapter } from '@brainstrike/utils';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type RightPanelTab = 'assistant' | 'embeddings' | 'database';

interface RightPanelData {
  activeTab: RightPanelTab;
}

interface RightPanelActions {
  setActiveTab: (tab: RightPanelTab) => void;
}

export type RightPanelStore = RightPanelData & RightPanelActions;

const STORE_NAME = 'right-panel.v1' as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeStorageAdapter());

export const useRightPanelStore = create<RightPanelStore>()(
  persist(
    (set) => ({
      activeTab: 'assistant',
      setActiveTab: (tab) => set({ activeTab: tab }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({ activeTab: s.activeTab }),
    }
  )
);

export const rightPanelSelectors = {
  activeTab: (s: RightPanelStore) => s.activeTab as RightPanelTab,
};

// Test-only helper to reset store and storage
export function __resetRightPanelStoreForTests() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_NAME);
  } catch (error) {
    console.warn('[Test] Failed to remove storage in test reset:', error);
  }
  useRightPanelStore.setState({ activeTab: 'assistant' });
}
