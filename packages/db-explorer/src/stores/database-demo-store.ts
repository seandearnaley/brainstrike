import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

interface DatabaseDemoData {
  expandedFileIds: string[];
  searchQuery: string;
  searchThreshold: number;
  showSettings: boolean;
}

interface DatabaseDemoActions {
  addExpanded: (id: string) => void;
  clearExpanded: () => void;
  removeExpanded: (id: string) => void;
  setExpanded: (ids: string[]) => void;
  setSearchQuery: (q: string) => void;
  setSearchThreshold: (t: number) => void;
  setShowSettings: (v: boolean) => void;
}

export type DatabaseDemoStore = DatabaseDemoData & DatabaseDemoActions;

const STORE_NAME = 'database-demo.v2' as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storage = createJSONStorage(() => createSafeJsonStorageAdapter());

export const useDatabaseDemoStore = create<DatabaseDemoStore>()(
  persist(
    (set, get) => ({
      showSettings: false,
      expandedFileIds: [],
      searchQuery: '',
      searchThreshold: 0.5,

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
      version: 2,
      storage,
      partialize: (s) => ({
        showSettings: s.showSettings,
        expandedFileIds: s.expandedFileIds,
        searchQuery: s.searchQuery,
        searchThreshold: s.searchThreshold,
      }),
    }
  )
);

export const databaseDemoSelectors = {
  settings: (s: DatabaseDemoStore) => s.showSettings,
  expanded: (s: DatabaseDemoStore) => s.expandedFileIds,
  search: (s: DatabaseDemoStore) => [s.searchQuery, s.searchThreshold] as const,
};

// Test helper to reset persistent state between tests
export function __resetDatabaseDemoStoreForTests() {
  try {
    useDatabaseDemoStore.setState({
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
  } catch {
    // Intentionally silent in tests - if storage fails, state is still reset
    // This prevents test failures when localStorage is unavailable
  }
}
