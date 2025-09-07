import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export interface FileTabState {
  id: string;
  path: string;
  compositeKey: string;
  content: string | null;
  isLoading: boolean;
  error?: string | undefined;
}

interface TabManagerData {
  tabs: FileTabState[];
  activeTabId: string | null;
}

interface TabManagerActions {
  openTab: (path: string, tabId: string, compositeKey: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  setTabLoading: (tabId: string, isLoading: boolean) => void;
  setTabError: (tabId: string, error: string) => void;
  clearTabs: () => void;
}

export type TabManagerStore = TabManagerData & TabManagerActions;

type PersistedTab = { id: string; path: string; compositeKey: string };
type PersistedState = { tabs: PersistedTab[]; activeTabId: string | null };

const STORE_NAME = 'tab-manager.v1' as const;

const storage = createJSONStorage(() => {
  // Safe storage wrapper for SSR/tests
  const memory = new Map<string, string>();
  return {
    getItem: (name: string) => {
      try {
        if (typeof localStorage !== 'undefined') return localStorage.getItem(name);
      } catch {}
      return memory.get(name) ?? null;
    },
    setItem: (name: string, value: string) => {
      try {
        if (typeof localStorage !== 'undefined') return localStorage.setItem(name, value);
      } catch {}
      memory.set(name, value);
    },
    removeItem: (name: string) => {
      try {
        if (typeof localStorage !== 'undefined') return localStorage.removeItem(name);
      } catch {}
      memory.delete(name);
    },
  };
});

export const useTabManagerStore = create<TabManagerStore>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,

      openTab: (path, tabId, compositeKey) => {
        set((state) => {
          const existing = state.tabs.find((t) => t.id === tabId);
          if (existing) {
            return { ...state, activeTabId: tabId };
          }
          const newTab: FileTabState = {
            id: tabId,
            path,
            compositeKey,
            content: null,
            isLoading: true,
          };
          return { tabs: [...state.tabs, newTab], activeTabId: tabId };
        });
      },

      closeTab: (tabId) => {
        set((state) => {
          const newTabs = state.tabs.filter((t) => t.id !== tabId);
          let nextActive = state.activeTabId;
          if (state.activeTabId === tabId) {
            // choose next tab in list or previous
            const prevIndex = state.tabs.findIndex((t) => t.id === tabId);
            const candidate = newTabs[prevIndex] || newTabs[prevIndex - 1] || null;
            nextActive = candidate ? candidate.id : null;
          }
          return { tabs: newTabs, activeTabId: nextActive };
        });
      },

      setActiveTab: (tabId) => set({ activeTabId: tabId }),

      updateTabContent: (tabId, content) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, content, isLoading: false, error: undefined } : t
          ),
        })),

      setTabLoading: (tabId, isLoading) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  isLoading,
                  content: isLoading ? null : t.content,
                  error: isLoading ? undefined : t.error,
                }
              : t
          ),
        })),

      setTabError: (tabId, error) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, error, isLoading: false } : t)),
        })),

      clearTabs: () => set({ tabs: [], activeTabId: null }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s): PersistedState => ({
        tabs: s.tabs.map((t) => ({ id: t.id, path: t.path, compositeKey: t.compositeKey })),
        activeTabId: s.activeTabId,
      }),
      merge: (persisted, current) => {
        const ps = (persisted as unknown as PersistedState) || { tabs: [], activeTabId: null };
        const reconstructed: FileTabState[] = ps.tabs.map((t) => ({
          id: t.id,
          path: t.path,
          compositeKey: t.compositeKey,
          content: null,
          isLoading: false,
          error: undefined,
        }));
        return { ...current, tabs: reconstructed, activeTabId: ps.activeTabId } as TabManagerStore;
      },
    }
  )
);

// Test-only helper to reset store and persistence between tests
export function __resetTabManagerStoreForTests() {
  try {
    // Clear in-memory state
    useTabManagerStore.setState({ tabs: [], activeTabId: null });
    // Clear persisted storage if available
    const persistApi = (
      useTabManagerStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
