import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type RightPanelTab = 'properties' | 'embeddings' | 'search' | 'database';

interface RightPanelData {
  activeTab: RightPanelTab;
}

interface RightPanelActions {
  setActiveTab: (tab: RightPanelTab) => void;
}

export type RightPanelStore = RightPanelData & RightPanelActions;

const STORE_NAME = 'right-panel.v1' as const;

// Safe storage for SSR/tests
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

export const useRightPanelStore = create<RightPanelStore>()(
  persist(
    (set) => ({
      activeTab: 'properties',
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
  } catch {}
  useRightPanelStore.setState({ activeTab: 'properties' });
}
