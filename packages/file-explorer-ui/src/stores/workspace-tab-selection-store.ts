import { createSafeJsonStateStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  LOGS_APP_ID,
  TERMINAL_APP_ID,
  THREAD_CONTEXT_APP_ID,
} from '../shell/workspace-app';

// Re-exported so non-UI consumers (entry-point stores, factory reset) can
// reach the app ids through this dependency-light subpath instead of the
// shell barrel (which drags the whole UI graph into a plain store module).
export {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  LOGS_APP_ID,
  TERMINAL_APP_ID,
  THREAD_CONTEXT_APP_ID,
};

export type WorkspaceTabSelection =
  | { kind: 'app'; appId: string }
  | { kind: 'file'; tabId: string }
  /**
   * Nothing is open in the workspace — the launcher empty state renders. A real,
   * persisted state (closing every tab must survive a reload), not a transient
   * fallback for malformed payloads (those coerce to {@link DEFAULT_SELECTION}).
   */
  | { kind: 'empty' };

interface WorkspaceTabSelectionState {
  /**
   * Close an app tab. If it was selected, selection moves to the adjacent open
   * app (the one that slid into its index, else the new last one); with no open
   * apps left the selection becomes `{kind:'empty'}`. Returns the successor
   * appId, or `null` when none — the caller (workspace tabs controller) may
   * then prefer the active FILE tab, which this store cannot see.
   */
  closeApp: (appId: string) => string | null;
  /**
   * Close several app tabs in ONE transition (tab-menu Close Others / Close
   * All). Selection follows {@link closeApp}'s rules: a surviving selection
   * stays; a closed one moves to the next surviving app after it, else the
   * last surviving app, else `{kind:'empty'}`. Returns that successor, or
   * `null` when the selection did not move to an app.
   */
  closeApps: (appIds: readonly string[]) => string | null;
  /**
   * Thread-workspace hydration entry point (BST-1268): replace the open list
   * and selection atomically from a snapshot. Mounted apps re-seed from the
   * hydrated selection only — surfaces from the previous thread stay mounted
   * in React (keep-alive), but a hydrate marks only the visible app as
   * "activated" for the incoming thread. Runs through the same persisted-
   * shape coercion as rehydration so snapshot payloads can never violate the
   * selection⊂openAppIds invariant.
   */
  hydrate: (openAppIds: readonly string[], selection: WorkspaceTabSelection) => void;
  /**
   * A fresh identity per {@link hydrate} (never persisted): the open set was
   * REPLACED by another thread's workspace, not closed.
   */
  hydration: object;
  /**
   * Apps that have been ACTIVATED at least once this session — the keep-alive
   * set the workspace body renders hidden-but-mounted (Canvas's sandboxed
   * iframe and the explorer layout must never remount). Session-only (not
   * persisted; a rehydrated app selection re-seeds it); grows on activation,
   * including a close that selects a successor, and never shrinks on close.
   */
  mountedAppIds: readonly string[];
  /** Open (add if missing) AND activate an app tab. Singleton: re-open activates. */
  openApp: (appId: string) => void;
  /**
   * App tabs currently open in the strip, in open order. Display order is the
   * app REGISTRY's order (the strip intersects registry × this list); this
   * array is set-like bookkeeping, not presentation order.
   */
  openAppIds: readonly string[];
  /** Factory-reset entry point (AGENTS.md: every persistent store wires into reset). */
  reset: () => void;
  /**
   * Alias of {@link openApp}, kept for existing call sites. Selecting an app
   * that is not open opens it — a selection pointing outside `openAppIds` is an
   * invariant violation, so the write repairs rather than silently no-ops.
   */
  selectApp: (appId: string) => void;
  /** Explicit empty selection (controller fallbacks when nothing remains open). */
  selectEmpty: () => void;
  selectFile: (tabId: string) => void;
  selection: WorkspaceTabSelection;
}

/**
 * Frozen at `.v1` even though the schema `version` is now 2 — renaming the
 * storage key would orphan persisted user state (house rule; see
 * `context-explorer-layout-store.ts`).
 */
const STORE_NAME = 'workspace-tab-selection.v1' as const;
const DEFAULT_SELECTION: WorkspaceTabSelection = {
  appId: CONTEXT_EXPLORER_APP_ID,
  kind: 'app',
};
const DEFAULT_OPEN_APP_IDS: readonly string[] = [CONTEXT_EXPLORER_APP_ID];

const storage = createJSONStorage(() =>
  createSafeJsonStateStorage({ scope: 'WorkspaceTabSelectionStore' })
);

interface PersistedWorkspaceTabState {
  readonly openAppIds: readonly string[];
  readonly selection: WorkspaceTabSelection;
}

/**
 * Validate a persisted selection shape. localStorage can be tampered with from
 * DevTools or corrupted across versions — without this guard, `{ kind: 'file' }`
 * (no tabId) would crash any consumer reading `selection.tabId`. Falls back to
 * the default on any malformed payload.
 */
function coerceSelection(value: unknown): WorkspaceTabSelection {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_SELECTION;
  }
  const candidate = value as Partial<{ appId: unknown; kind: unknown; tabId: unknown }>;
  if (candidate.kind === 'file' && typeof candidate.tabId === 'string') {
    return { kind: 'file', tabId: candidate.tabId };
  }
  if (candidate.kind === 'app' && typeof candidate.appId === 'string') {
    return { appId: candidate.appId, kind: 'app' };
  }
  if (candidate.kind === 'empty') {
    return { kind: 'empty' };
  }
  return DEFAULT_SELECTION;
}

function coerceOpenAppIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      ids.add(entry);
    }
  }
  return [...ids];
}

/**
 * Validate the complete persisted shape (house `merge` convention: return the
 * FULL persisted-data shape, never a sparse patch). Invariant enforced here: a
 * `kind:'app'` selection's id is always a member of `openAppIds` — appended
 * when missing so a tampered list never strands the visible selection.
 */
function coercePersisted(value: unknown): PersistedWorkspaceTabState {
  const candidate = (value ?? {}) as Partial<{ openAppIds: unknown; selection: unknown }>;
  const openAppIds = coerceOpenAppIds(candidate.openAppIds);
  if (openAppIds === null) {
    return { openAppIds: DEFAULT_OPEN_APP_IDS, selection: DEFAULT_SELECTION };
  }
  const selection = coerceSelection(candidate.selection);
  if (selection.kind === 'app' && !openAppIds.includes(selection.appId)) {
    return { openAppIds: [...openAppIds, selection.appId], selection };
  }
  return { openAppIds, selection };
}

/**
 * Invariant: a selected app is always mounted. `openApp`, `closeApp` and
 * `closeApps` add their selected app through here (hydrate and rehydration
 * re-seed from the selection), so a close that selects a restored but never
 * activated successor still renders it instead of leaving the panel blank.
 */
function withMounted(mountedAppIds: readonly string[], appId: string): readonly string[] {
  return mountedAppIds.includes(appId) ? mountedAppIds : [...mountedAppIds, appId];
}

export const useWorkspaceTabSelectionStore = create<WorkspaceTabSelectionState>()(
  persist(
    (set, get) => ({
      closeApp: (appId) => {
        const { mountedAppIds, openAppIds, selection } = get();
        const index = openAppIds.indexOf(appId);
        if (index === -1) {
          return null;
        }
        const nextOpen = openAppIds.filter((id) => id !== appId);
        const closingActive = selection.kind === 'app' && selection.appId === appId;
        if (!closingActive) {
          set({ openAppIds: nextOpen });
          return null;
        }
        const successor = nextOpen[index] ?? nextOpen.at(-1) ?? null;
        set({
          mountedAppIds: successor === null ? mountedAppIds : withMounted(mountedAppIds, successor),
          openAppIds: nextOpen,
          selection: successor === null ? { kind: 'empty' } : { appId: successor, kind: 'app' },
        });
        return successor;
      },
      closeApps: (appIds) => {
        const { mountedAppIds, openAppIds, selection } = get();
        const closing = new Set(appIds);
        const nextOpen = openAppIds.filter((id) => !closing.has(id));
        if (nextOpen.length === openAppIds.length) {
          return null;
        }
        const closingActive = selection.kind === 'app' && closing.has(selection.appId);
        if (!closingActive) {
          set({ openAppIds: nextOpen });
          return null;
        }
        const selectedIndex = openAppIds.indexOf(selection.appId);
        const successor =
          openAppIds.slice(selectedIndex + 1).find((id) => !closing.has(id)) ??
          nextOpen.at(-1) ??
          null;
        set({
          mountedAppIds: successor === null ? mountedAppIds : withMounted(mountedAppIds, successor),
          openAppIds: nextOpen,
          selection: successor === null ? { kind: 'empty' } : { appId: successor, kind: 'app' },
        });
        return successor;
      },
      hydrate: (openAppIds, selection) => {
        const coerced = coercePersisted({ openAppIds, selection });
        set({
          hydration: {},
          mountedAppIds: coerced.selection.kind === 'app' ? [coerced.selection.appId] : [],
          openAppIds: coerced.openAppIds,
          selection: coerced.selection,
        });
      },
      hydration: {},
      mountedAppIds: DEFAULT_OPEN_APP_IDS,
      openApp: (appId) =>
        set((state) => ({
          mountedAppIds: withMounted(state.mountedAppIds, appId),
          openAppIds: state.openAppIds.includes(appId)
            ? state.openAppIds
            : [...state.openAppIds, appId],
          selection: { appId, kind: 'app' },
        })),
      openAppIds: DEFAULT_OPEN_APP_IDS,
      reset: () =>
        set({
          mountedAppIds: DEFAULT_OPEN_APP_IDS,
          openAppIds: DEFAULT_OPEN_APP_IDS,
          selection: DEFAULT_SELECTION,
        }),
      selectApp: (appId) => get().openApp(appId),
      selectEmpty: () => set({ selection: { kind: 'empty' } }),
      selectFile: (tabId) => set({ selection: { kind: 'file', tabId } }),
      selection: DEFAULT_SELECTION,
    }),
    {
      merge: (persisted, current) => {
        const coerced = coercePersisted(persisted);
        // mountedAppIds is session-only: seed it from the restored selection so
        // the restored app renders, and nothing else mounts until activated.
        return {
          ...current,
          ...coerced,
          mountedAppIds: coerced.selection.kind === 'app' ? [coerced.selection.appId] : [],
        };
      },
      migrate: (persisted, fromVersion) => {
        if (fromVersion >= 2) {
          return persisted as PersistedWorkspaceTabState;
        }
        // v1 persisted only { selection }. Seed the open list with the Context
        // Explorer app (the previous permanent tab) so existing users keep
        // their current default view; an app selection joins the list too.
        const selection = coerceSelection(
          (persisted as Partial<{ selection: unknown }> | null)?.selection
        );
        const openAppIds =
          selection.kind === 'app' && selection.appId !== CONTEXT_EXPLORER_APP_ID
            ? [...DEFAULT_OPEN_APP_IDS, selection.appId]
            : DEFAULT_OPEN_APP_IDS;
        return { openAppIds, selection };
      },
      name: STORE_NAME,
      partialize: (s) => ({ openAppIds: s.openAppIds, selection: s.selection }),
      storage,
      version: 2,
    }
  )
);

/** Test-only helper to reset store and persisted value between tests. */
export function __resetWorkspaceTabSelectionStoreForTests(): void {
  useWorkspaceTabSelectionStore.setState({
    mountedAppIds: DEFAULT_OPEN_APP_IDS,
    openAppIds: DEFAULT_OPEN_APP_IDS,
    selection: DEFAULT_SELECTION,
  });
  const persistApi = (
    useWorkspaceTabSelectionStore as unknown as {
      persist?: { clearStorage?: () => void };
    }
  ).persist;
  persistApi?.clearStorage?.();
}
