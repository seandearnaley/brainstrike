import { createSafeJsonStateStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { CONTEXT_EXPLORER_APP_ID } from '../shell/workspace-app';

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
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && !ids.includes(entry)) {
      ids.push(entry);
    }
  }
  return ids;
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

export const useWorkspaceTabSelectionStore = create<WorkspaceTabSelectionState>()(
  persist(
    (set, get) => ({
      closeApp: (appId) => {
        const { openAppIds, selection } = get();
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
          openAppIds: nextOpen,
          selection: successor === null ? { kind: 'empty' } : { appId: successor, kind: 'app' },
        });
        return successor;
      },
      openApp: (appId) =>
        set((state) => ({
          openAppIds: state.openAppIds.includes(appId)
            ? state.openAppIds
            : [...state.openAppIds, appId],
          selection: { appId, kind: 'app' },
        })),
      openAppIds: DEFAULT_OPEN_APP_IDS,
      reset: () => set({ openAppIds: DEFAULT_OPEN_APP_IDS, selection: DEFAULT_SELECTION }),
      selectApp: (appId) => get().openApp(appId),
      selectEmpty: () => set({ selection: { kind: 'empty' } }),
      selectFile: (tabId) => set({ selection: { kind: 'file', tabId } }),
      selection: DEFAULT_SELECTION,
    }),
    {
      merge: (persisted, current) => ({ ...current, ...coercePersisted(persisted) }),
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
