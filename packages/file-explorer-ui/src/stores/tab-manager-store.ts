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
  /**
   * Close a tab and return the resulting active tab id (or null if no tabs remain).
   * Returning the successor makes the contract explicit so callers don't need to read
   * `useTabManagerStore.getState().activeTabId` immediately after closing.
   */
  closeTab: (tabId: string) => string | null;
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
              id: t.id,
              path: t.path,
              compositeKey: t.compositeKey,
            }))
        : [],
      activeTabId: (parsed.activeTabId ?? null) as string | null,
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

const storage = createJSONStorage(() =>
  createSafeJsonStateStorage({
    scope: 'TabManagerStore',
    migrateOnGet: migrateLegacyTabKey,
  })
);

export const useTabManagerStore = create<TabManagerStore>()(
  persist(
    (set, get) => ({
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
          return { tabs: nextTabs, activeTabId: tabId };
        });
      },

      closeTab: (tabId) => {
        // Compute the successor against the snapshot from get() so the value we return
        // never depends on observing post-set state — this used to reach into the
        // updater closure via a let-mutation, which was correct but coupled the return
        // contract to Zustand's synchronous-set internals. Reading first, then setting,
        // makes the contract entirely explicit.
        const state = get();
        const newTabs = state.tabs.filter((t) => t.id !== tabId);
        let nextActive = state.activeTabId;
        if (state.activeTabId === tabId) {
          const prevIndex = state.tabs.findIndex((t) => t.id === tabId);
          const candidate = newTabs[prevIndex] || newTabs[prevIndex - 1] || null;
          nextActive = candidate ? candidate.id : null;
        }
        set({ tabs: newTabs, activeTabId: nextActive });
        return nextActive;
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
        // Future v3+ migrations: replace this with a per-version chain (e.g.
        //   if (version < 2) ps = migrateV1ToV2(ps);
        //   if (version < 3) ps = migrateV2ToV3(ps);
        //   return ps;
        // ) and bump STORE_VERSION accordingly. The current `>= 2` guard means we
        // skip *all* migrations once we hit v2, which is fine while v2 is the
        // latest but would silently skip a v3 pass if added without updating here.
        if (version >= 2) {
          return ps;
        }
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
          tabs.push({ id: nextId, path: t.path, compositeKey: t.compositeKey });
        }
        const remappedActive =
          ps.activeTabId === null ? null : (remap.get(ps.activeTabId) ?? ps.activeTabId);
        // If the originally-active id deduped away, fall back to the first remaining tab.
        const activeTabId =
          remappedActive !== null && seen.has(remappedActive)
            ? remappedActive
            : (tabs[0]?.id ?? null);
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
