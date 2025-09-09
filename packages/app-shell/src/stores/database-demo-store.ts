import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type DemoView = 'files' | 'chunks' | 'search';

interface DatabaseDemoData {
  selectedView: DemoView;
  showSettings: boolean;
  expandedFileIds: string[];
  searchQuery: string;
  searchThreshold: number;
}

interface DatabaseDemoActions {
  setSelectedView: (v: DemoView) => void;
  setShowSettings: (v: boolean) => void;
  addExpanded: (id: string) => void;
  removeExpanded: (id: string) => void;
  setExpanded: (ids: string[]) => void;
  clearExpanded: () => void;
  setSearchQuery: (q: string) => void;
  setSearchThreshold: (t: number) => void;
}

export type DatabaseDemoStore = DatabaseDemoData & DatabaseDemoActions;

const STORE_NAME = 'database-demo.v1' as const;

// SSR-safe storage
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

export const useDatabaseDemoStore = create<DatabaseDemoStore>()(
  persist(
    (set, get) => ({
      selectedView: 'files',
      showSettings: false,
      expandedFileIds: [],
      searchQuery: '',
      searchThreshold: 0.5,

      setSelectedView: (v) => set({ selectedView: v }),
      setShowSettings: (v) => set({ showSettings: v }),
      addExpanded: (id) =>
        set({ expandedFileIds: Array.from(new Set([...get().expandedFileIds, id])) }),
      removeExpanded: (id) =>
        set({ expandedFileIds: get().expandedFileIds.filter((x) => x !== id) }),
      setExpanded: (ids) => set({ expandedFileIds: Array.from(new Set(ids)) }),
      clearExpanded: () => set({ expandedFileIds: [] }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      setSearchThreshold: (t) =>
        set({ searchThreshold: Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5)) }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({
        selectedView: s.selectedView,
        showSettings: s.showSettings,
        expandedFileIds: s.expandedFileIds,
        searchQuery: s.searchQuery,
        searchThreshold: s.searchThreshold,
      }),
    }
  )
);

export const databaseDemoSelectors = {
  viewAndSettings: (s: DatabaseDemoStore) => [s.selectedView, s.showSettings] as const,
  expanded: (s: DatabaseDemoStore) => s.expandedFileIds,
  search: (s: DatabaseDemoStore) => [s.searchQuery, s.searchThreshold] as const,
};

// Test helper to reset persistent state between tests
export function __resetDatabaseDemoStoreForTests() {
  try {
    useDatabaseDemoStore.setState({
      selectedView: 'files',
      showSettings: false,
      expandedFileIds: [],
      searchQuery: '',
      searchThreshold: 0.5,
    });
    const persistApi = (
      useDatabaseDemoStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
