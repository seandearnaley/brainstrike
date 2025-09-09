import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type DbSubtab = 'overview' | 'logs' | 'config';

interface DbPanelData {
  activeSubtab: DbSubtab;
  page: number;
  pageSize: number;
  sortBy: string | null;
  sortDir: 'asc' | 'desc';
  filterText: string;
}

interface DbPanelActions {
  setActiveSubtab: (t: DbSubtab) => void;
  setPage: (p: number) => void;
  setPageSize: (s: number) => void;
  setSort: (by: string | null, dir: 'asc' | 'desc') => void;
  setFilterText: (t: string) => void;
}

export type DbPanelStore = DbPanelData & DbPanelActions;

const STORE_NAME = 'db-panel.v1' as const;

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

export const useDbPanelStore = create<DbPanelStore>()(
  persist(
    (set) => ({
      activeSubtab: 'overview',
      page: 1,
      pageSize: 20,
      sortBy: null,
      sortDir: 'asc',
      filterText: '',

      setActiveSubtab: (t) => set({ activeSubtab: t }),
      setPage: (p) => set({ page: Math.max(1, Math.floor(p)) }),
      setPageSize: (s) => set({ pageSize: Math.max(1, Math.floor(s)) }),
      setSort: (by, dir) => set({ sortBy: by, sortDir: dir }),
      setFilterText: (t) => set({ filterText: t }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({
        activeSubtab: s.activeSubtab,
        pageSize: s.pageSize,
        sortBy: s.sortBy,
        sortDir: s.sortDir,
        filterText: s.filterText,
      }),
    }
  )
);

export const dbPanelSelectors = {
  sorting: (s: DbPanelStore) => [s.sortBy, s.sortDir] as const,
  paging: (s: DbPanelStore) => [s.page, s.pageSize] as const,
  filter: (s: DbPanelStore) => s.filterText,
  activeSubtab: (s: DbPanelStore) => s.activeSubtab,
};

// Test-only helper to reset store and storage
export function __resetDbPanelStoreForTests() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_NAME);
  } catch {}
  useDbPanelStore.setState({
    activeSubtab: 'overview',
    page: 1,
    pageSize: 20,
    sortBy: null,
    sortDir: 'asc',
    filterText: '',
  });
}
