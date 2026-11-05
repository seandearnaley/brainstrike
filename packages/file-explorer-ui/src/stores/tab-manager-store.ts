import { createLogger } from '@brainstrike/logging';
import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';

const logger = createLogger('TabManagerStore');

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
  /**
   * A fresh identity per `hydrateTabs` (never persisted): the tab set was
   * REPLACED by another thread's workspace, which subscribers such as the
   * closed-tab history must tell apart from closes.
   */
  hydration: object;
  tabs: FileTabState[];
}

interface TabManagerActions {
  clearTabs: () => void;
  /** Atomically keep only `tabId`; returns the resulting active tab. */
  closeOtherTabs: (tabId: string) => string | null;
  /**
   * Close a tab and return the resulting active tab id (or null if no tabs remain).
   * Returning the successor makes the contract explicit so callers don't need to read
   * `useTabManagerStore.getState().activeTabId` immediately after closing.
   */
  closeTab: (tabId: string) => string | null;
  /** Atomically close every tab after `tabId`; returns the resulting active tab. */
  closeTabsToRight: (tabId: string) => string | null;
  /**
   * Thread-workspace hydration entry point (BST-1268): replace the whole tab
   * list and active id atomically from a snapshot. Content/loading reset to
   * the not-yet-loaded shape (the restoration + auto-load flows re-resolve,
   * exactly as after a reload); an active id not present in the list drops to
   * null rather than pointing at a phantom tab.
   */
  hydrateTabs: (
    tabs: ReadonlyArray<{ compositeKey: string; path: string }>,
    activeTabId: string | null
  ) => void;
  openTab: (path: string, tabId: string, compositeKey: string) => void;
  /**
   * Atomically adopt `orderedTabIds` as the tab order. Only an exact
   * permutation of the open tab ids is accepted; anything else (a stale drag,
   * a missing or foreign id) is rejected with a warning and changes nothing.
   * Array order IS the persisted order, so `tab-manager.v1` needs no migration.
   */
  reorderTabs: (orderedTabIds: readonly string[]) => void;
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

const STORE_NAME = 'brainstrike:tab-manager.v1' as const;
const MAX_TABS = 20;

/** `tabs` in `orderedTabIds` order, or null unless the ids are an exact permutation. */
function permuteTabs(
  tabs: readonly FileTabState[],
  orderedTabIds: readonly string[]
): FileTabState[] | null {
  if (orderedTabIds.length !== tabs.length) {
    return null;
  }
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const reordered: FileTabState[] = [];
  for (const id of orderedTabIds) {
    const tab = byId.get(id);
    if (!tab) {
      return null;
    }
    byId.delete(id);
    reordered.push(tab);
  }
  return reordered;
}

export const useTabManagerStore = create<TabManagerStore>()(
  persistDurable(
    STORE_NAME,
    (set, get) => ({
      activeTabId: null,

      clearTabs: () => set({ activeTabId: null, tabs: [] }),

      closeOtherTabs: (tabId) => {
        const state = get();
        const retainedTab = state.tabs.find((tab) => tab.id === tabId);
        if (!retainedTab) {
          return state.activeTabId;
        }
        if (state.tabs.length === 1 && state.activeTabId === tabId) {
          return tabId;
        }
        set({ activeTabId: tabId, tabs: [retainedTab] });
        return tabId;
      },

      closeTab: (tabId) => {
        // Compute the successor against the snapshot from get() so the value we return
        // never depends on observing post-set state — this used to reach into the
        // updater closure via a let-mutation, which was correct but coupled the return
        // contract to Zustand's synchronous-set internals. Reading first, then setting,
        // makes the contract entirely explicit.
        const state = get();
        if (!state.tabs.some((tab) => tab.id === tabId)) {
          return state.activeTabId;
        }
        const newTabs = state.tabs.filter((t) => t.id !== tabId);
        let nextActive = state.activeTabId;
        if (state.activeTabId === tabId) {
          const prevIndex = state.tabs.findIndex((t) => t.id === tabId);
          const candidate = newTabs[prevIndex] || newTabs[prevIndex - 1] || null;
          nextActive = candidate ? candidate.id : null;
        }
        set({ activeTabId: nextActive, tabs: newTabs });
        return nextActive;
      },

      closeTabsToRight: (tabId) => {
        const state = get();
        const targetIndex = state.tabs.findIndex((tab) => tab.id === tabId);
        if (targetIndex === -1) {
          return state.activeTabId;
        }
        const remainingTabs = state.tabs.slice(0, targetIndex + 1);
        if (remainingTabs.length === state.tabs.length) {
          return state.activeTabId;
        }
        const activeTabId = remainingTabs.some((tab) => tab.id === state.activeTabId)
          ? state.activeTabId
          : tabId;
        set({ activeTabId, tabs: remainingTabs });
        return activeTabId;
      },
      hydrateTabs: (tabs, activeTabId) => {
        const hydrated = tabs.map((tab) => ({
          compositeKey: tab.compositeKey,
          content: null,
          id: tab.compositeKey,
          isLoading: false,
          path: tab.path,
        }));
        const activeExists = hydrated.some((tab) => tab.id === activeTabId);
        set({ activeTabId: activeExists ? activeTabId : null, hydration: {}, tabs: hydrated });
      },
      hydration: {},

      openTab: (path, tabId, compositeKey) => {
        set((state) => {
          const existing = state.tabs.find((t) => t.id === tabId);
          if (existing) {
            return { ...state, activeTabId: tabId };
          }
          const newTab: FileTabState = {
            compositeKey,
            content: null,
            id: tabId,
            isLoading: true,
            path,
          };
          const nextTabs = [...state.tabs, newTab];
          if (nextTabs.length > MAX_TABS) {
            // TODO(tab-eviction-ux): surface a toast or visual cue when the oldest
            // tab is evicted so a 21st open does not look like a disappearing tab.
            // Until then, log a warning so the silent eviction is at least debuggable.
            const evicted = nextTabs[0];
            logger.warn('Tab limit reached; evicting oldest tab', {
              evictedId: evicted?.id,
              evictedPath: evicted?.path,
              limit: MAX_TABS,
            });
            nextTabs.shift();
          }
          return { activeTabId: tabId, tabs: nextTabs };
        });
      },

      reorderTabs: (orderedTabIds) => {
        const { tabs } = get();
        const reordered = permuteTabs(tabs, orderedTabIds);
        if (reordered === null) {
          logger.warn('Rejected a tab reorder that is not a permutation of the open tabs', {
            openTabCount: tabs.length,
            orderedTabCount: orderedTabIds.length,
          });
          return;
        }
        if (
          reordered.length === tabs.length &&
          reordered.every((tab, index) => tab === tabs[index])
        ) {
          return;
        }
        set({ tabs: reordered });
      },

      setActiveTab: (tabId) => set({ activeTabId: tabId }),

      setTabError: (tabId, error) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, error, isLoading: false } : t)),
        })),

      setTabLoading: (tabId, isLoading) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  content: isLoading ? null : t.content,
                  error: isLoading ? undefined : t.error,
                  isLoading,
                }
              : t
          ),
        })),
      tabs: [],

      updateTabContent: (tabId, content) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, content, error: undefined, isLoading: false } : t
          ),
        })),
    }),
    {
      merge: (persisted, current) => {
        const ps = (persisted as unknown as PersistedState) || { activeTabId: null, tabs: [] };
        const reconstructed: FileTabState[] = ps.tabs.map((t) => ({
          compositeKey: t.compositeKey,
          content: null,
          error: undefined,
          id: t.id,
          isLoading: false,
          path: t.path,
        }));
        return { ...current, activeTabId: ps.activeTabId, tabs: reconstructed } as TabManagerStore;
      },
      partialize: (s): PersistedState => ({
        activeTabId: s.activeTabId,
        tabs: s.tabs.map((t) => ({ compositeKey: t.compositeKey, id: t.id, path: t.path })),
      }),
      version: 1,
    }
  )
);
