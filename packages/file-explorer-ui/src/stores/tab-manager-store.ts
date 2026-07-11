import { createSafeJsonStateStorage } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils/logger';
import { createJSONStorage, persist } from 'zustand/middleware';
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
const LEGACY_STORE_KEY = 'fileEditorTabs.v1' as const;
const MAX_TABS = 20;

/**
 * One-time migration from the pre-rename `fileEditorTabs.v1` key into the canonical
 * `tab-manager.v1` shape. Wired into the shared safe-state-storage's `migrateOnGet`
 * hook so a clean install never pays the cost.
 */
function migrateLegacyTabKey(name: string): string | null {
  if (name !== STORE_NAME || typeof localStorage === 'undefined') {
    return null;
  }
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_STORE_KEY);
  } catch {
    return null;
  }
  if (!legacy) {
    return null;
  }
  try {
    const parsed = JSON.parse(legacy) as {
      tabs?: Array<{ id: string; path: string; compositeKey: string }>;
      activeTabId?: string | null;
    };
    const migrated: PersistedState = {
      activeTabId: (parsed.activeTabId ?? null) as string | null,
      // Filter out malformed legacy entries before stringifying — without this, a
      // missing field would produce String(undefined) === 'undefined' and create a
      // phantom tab with that literal id. Unlikely on existing installs but cheap
      // insurance for any localStorage tampering or partial-write corruption.
      tabs: Array.isArray(parsed.tabs)
        ? parsed.tabs
            .filter(
              (t): t is { id: string; path: string; compositeKey: string } =>
                typeof t?.id === 'string' &&
                typeof t.path === 'string' &&
                typeof t.compositeKey === 'string'
            )
            .map((t) => ({
              compositeKey: t.compositeKey,
              id: t.id,
              path: t.path,
            }))
        : [],
    };
    const wrapped = JSON.stringify({ state: migrated, version: 1 });
    try {
      localStorage.setItem(name, wrapped);
      localStorage.removeItem(LEGACY_STORE_KEY);
    } catch {
      // If we can't persist the migrated value, still return it so the runtime store
      // hydrates correctly for this session.
    }
    return wrapped;
  } catch {
    return null;
  }
}

/**
 * v1 → v2: legacy tabIds were `${rootFolderId}:${compositeKey}` to dedupe per-folder.
 * The compositeKey already encodes folder identity, so we collapse the tabId to the
 * compositeKey itself. This makes opens stable across reloads on web (where the
 * rootDirectoryHandle's identity does not survive page reloads). Also dedupes any
 * cross-rootFolderId duplicates and remaps activeTabId.
 */
function migrateV1ToV2(ps: PersistedState): PersistedState {
  const remap = new Map<string, string>();
  const seen = new Set<string>();
  const tabs: PersistedTab[] = [];
  for (const t of ps.tabs) {
    const nextId = t.compositeKey;
    if (t.id !== nextId) {
      remap.set(t.id, nextId);
    }
    // Dedupe by compositeKey: in v1 a user could have the same file opened under
    // different rootFolderId prefixes; collapsing to compositeKey would otherwise
    // produce duplicate ids (and React-key conflicts). Keep the first occurrence.
    if (seen.has(nextId)) {
      continue;
    }
    seen.add(nextId);
    tabs.push({ compositeKey: t.compositeKey, id: nextId, path: t.path });
  }
  const remappedActive =
    ps.activeTabId === null ? null : (remap.get(ps.activeTabId) ?? ps.activeTabId);
  // If the originally-active id deduped away, fall back to the first remaining tab.
  const activeTabId =
    remappedActive !== null && seen.has(remappedActive) ? remappedActive : (tabs[0]?.id ?? null);
  return { activeTabId, tabs };
}

const storage = createJSONStorage(() =>
  createSafeJsonStateStorage({
    migrateOnGet: migrateLegacyTabKey,
    scope: 'TabManagerStore',
  })
);

export const useTabManagerStore = create<TabManagerStore>()(
  persist(
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
      // Migrations are written as a per-version chain so adding a v3 step is purely
      // additive — no need to update an existing guard. Future shape:
      //   let next = ps;
      //   if (version < 2) next = migrateV1ToV2(next);
      //   if (version < 3) next = migrateV2ToV3(next);
      //   return next;
      migrate: (persisted, version) => {
        let ps = (persisted as PersistedState | undefined) ?? {
          activeTabId: null,
          tabs: [],
        };
        if (version < 2) {
          ps = migrateV1ToV2(ps);
        }
        return ps;
      },
      name: STORE_NAME,
      partialize: (s): PersistedState => ({
        activeTabId: s.activeTabId,
        tabs: s.tabs.map((t) => ({ compositeKey: t.compositeKey, id: t.id, path: t.path })),
      }),
      storage,
      version: 2,
    }
  )
);

// Test-only helper to reset store and persistence between tests
export function __resetTabManagerStoreForTests() {
  try {
    // Clear in-memory state
    useTabManagerStore.setState({ activeTabId: null, tabs: [] });
    // Clear persisted storage if available
    const persistApi = (
      useTabManagerStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {}
}
