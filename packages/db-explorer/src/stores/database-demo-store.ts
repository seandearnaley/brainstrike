import { createSafeJsonStorageAdapter } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface DatabaseDemoData {
  expandedFileIds: string[];
  recordPage: number;
  recordPageSize: number;
  searchQuery: string;
  searchThreshold: number;
  showSettings: boolean;
}

interface DatabaseDemoActions {
  addExpanded: (id: string) => void;
  clearExpanded: () => void;
  removeExpanded: (id: string) => void;
  resetRecordPagination: () => void;
  setExpanded: (ids: string[]) => void;
  setRecordPage: (page: number) => void;
  setRecordPageSize: (pageSize: number) => void;
  setSearchQuery: (q: string) => void;
  setSearchThreshold: (t: number) => void;
  setShowSettings: (v: boolean) => void;
}

export type DatabaseDemoStore = DatabaseDemoData & DatabaseDemoActions;

const STORE_NAME = 'database-demo.v2' as const;
const STORE_VERSION = 3 as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

export const useDatabaseDemoStore = create<DatabaseDemoStore>()(
  persist(
    (set, get) => ({
      addExpanded: (id) =>
        set({ expandedFileIds: Array.from(new Set([...get().expandedFileIds, id])) }),
      clearExpanded: () => set({ expandedFileIds: [] }),
      expandedFileIds: [],
      recordPage: 0,
      recordPageSize: 50,
      removeExpanded: (id) =>
        set({ expandedFileIds: get().expandedFileIds.filter((x) => x !== id) }),
      resetRecordPagination: () => set({ recordPage: 0 }),
      searchQuery: '',
      searchThreshold: 0.5,
      setExpanded: (ids) => set({ expandedFileIds: Array.from(new Set(ids)) }),
      setRecordPage: (page) =>
        set({ recordPage: Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0 }),
      setRecordPageSize: (pageSize) => {
        const normalizedPageSize =
          Number.isFinite(pageSize) && pageSize > 0 ? Math.trunc(pageSize) : 50;
        set({ recordPage: 0, recordPageSize: normalizedPageSize });
      },
      setSearchQuery: (q) => set({ searchQuery: q }),
      setSearchThreshold: (t) =>
        set({ searchThreshold: Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5)) }),

      setShowSettings: (v) => set({ showSettings: v }),
      showSettings: false,
    }),
    {
      migrate: (persistedState) => {
        const snapshot =
          persistedState && typeof persistedState === 'object'
            ? (persistedState as Partial<DatabaseDemoStore>)
            : {};

        return {
          ...snapshot,
          showSettings: false,
        } satisfies Partial<DatabaseDemoStore>;
      },
      name: STORE_NAME,
      partialize: (s) => ({
        expandedFileIds: s.expandedFileIds,
        recordPage: s.recordPage,
        recordPageSize: s.recordPageSize,
        searchQuery: s.searchQuery,
        searchThreshold: s.searchThreshold,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

export const databaseDemoSelectors = {
  expanded: (s: DatabaseDemoStore) => s.expandedFileIds,
  pagination: (s: DatabaseDemoStore) => [s.recordPage, s.recordPageSize] as const,
  search: (s: DatabaseDemoStore) => [s.searchQuery, s.searchThreshold] as const,
  settings: (s: DatabaseDemoStore) => s.showSettings,
};

// Test helper to reset persistent state between tests
export function __resetDatabaseDemoStoreForTests() {
  try {
    useDatabaseDemoStore.setState({
      expandedFileIds: [],
      recordPage: 0,
      recordPageSize: 50,
      searchQuery: '',
      searchThreshold: 0.5,
      showSettings: false,
    });
    const persistApi = (
      useDatabaseDemoStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset
    // This prevents test failures when localStorage is unavailable
  }
}
