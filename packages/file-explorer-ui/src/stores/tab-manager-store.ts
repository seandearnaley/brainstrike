import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export interface FileTabState {
  compositeKey: string;
  content: string | null;
  error?: string | undefined;
  id: string;
  isLoading: boolean;
  path: string;
}

interface TabManagerData {
  activeTabId: string | null;
  tabs: FileTabState[];
}

interface TabManagerActions {
  clearTabs: () => void;
  closeTab: (tabId: string) => void;
  openTab: (path: string, tabId: string, compositeKey: string) => void;
  setActiveTab: (tabId: string) => void;
  setTabError: (tabId: string, error: string) => void;
  setTabLoading: (tabId: string, isLoading: boolean) => void;
  updateTabContent: (tabId: string, content: string) => void;
}

export type TabManagerStore = TabManagerData & TabManagerActions;

interface PersistedTab {
  compositeKey: string;
  id: string;
  path: string;
}
interface PersistedState {
  activeTabId: string | null;
  tabs: PersistedTab[];
}

const STORE_NAME = 'tab-manager.v1' as const;
const MAX_TABS = 20;

const storage = createJSONStorage(() => {
  // Safe storage wrapper for SSR/tests with one-time migration from legacy key
  const memory = new Map<string, string>();
  const LegacyKey = 'fileEditorTabs.v1';

  const fromLocalStorage = (key: string): string | null => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(key);
      }
    } catch {}
    return null;
  };

  const writeLocalStorage = (key: string, value: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
      }
    } catch {}
  };

  const removeLocalStorage = (key: string) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    } catch {}
  };

  const migrateIfNeeded = (name: string): string | null => {
    if (name !== STORE_NAME) {
      return null;
    }
    const legacy = fromLocalStorage(LegacyKey);
    if (!legacy) {
      return null;
    }
    try {
      const parsed = JSON.parse(legacy) as {
        tabs?: Array<{ id: string; path: string; compositeKey: string }>;
        activeTabId?: string | null;
      };
      const migrated: PersistedState = {
        tabs: Array.isArray(parsed.tabs)
          ? parsed.tabs.map((t) => ({
              id: String(t.id),
              path: String(t.path),
              compositeKey: String(t.compositeKey),
            }))
          : [],
        activeTabId: (parsed.activeTabId ?? null) as string | null,
      };
      const wrapped = JSON.stringify({ state: migrated, version: 1 });
      writeLocalStorage(name, wrapped);
      removeLocalStorage(LegacyKey);
      return wrapped;
    } catch {
      return null;
    }
  };

  const ensureValidJson = (name: string, value: string | null): string | null => {
    if (value === null) {
      return null;
    }
    try {
      JSON.parse(value);
      return value;
    } catch {
      removeLocalStorage(name);
      memory.delete(name);
      return null;
    }
  };

  return {
    getItem: (name: string) => {
      const direct = ensureValidJson(name, fromLocalStorage(name));
      if (direct !== null) {
        return direct;
      }
      const migrated = migrateIfNeeded(name);
      const validatedMigrated = ensureValidJson(name, migrated);
      if (validatedMigrated !== null) {
        return validatedMigrated;
      }
      return ensureValidJson(name, memory.get(name) ?? null);
    },
    setItem: (name: string, value: string) => {
      writeLocalStorage(name, value);
      if (!fromLocalStorage(name)) {
        memory.set(name, value);
      }
    },
    removeItem: (name: string) => {
      removeLocalStorage(name);
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
          const nextTabs = [...state.tabs, newTab];
          if (nextTabs.length > MAX_TABS) {
            nextTabs.shift();
          }
          return { tabs: nextTabs, activeTabId: tabId };
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
      version: 2,
      storage,
      partialize: (s): PersistedState => ({
        tabs: s.tabs.map((t) => ({ id: t.id, path: t.path, compositeKey: t.compositeKey })),
        activeTabId: s.activeTabId,
      }),
      // v1 → v2: legacy tabIds were `${rootFolderId}:${compositeKey}` to dedupe per-folder.
      // The compositeKey already encodes folder identity, so we collapse the tabId to the
      // compositeKey itself. This makes opens stable across reloads on web (where the
      // rootDirectoryHandle's identity does not survive page reloads).
      migrate: (persisted, version) => {
        const ps = (persisted as PersistedState | undefined) ?? {
          tabs: [],
          activeTabId: null,
        };
        if (version >= 2) {
          return ps;
        }
        const remap = new Map<string, string>();
        const tabs = ps.tabs.map((t) => {
          const nextId = t.compositeKey;
          if (t.id !== nextId) {
            remap.set(t.id, nextId);
          }
          return { id: nextId, path: t.path, compositeKey: t.compositeKey };
        });
        const activeTabId =
          ps.activeTabId === null ? null : (remap.get(ps.activeTabId) ?? ps.activeTabId);
        return { tabs, activeTabId };
      },
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
