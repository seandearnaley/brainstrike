import { createSafeJsonStateStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { CONTEXT_EXPLORER_APP_ID } from '../shell/workspace-app';

export type WorkspaceTabSelection =
  | { kind: 'app'; appId: string }
  | { kind: 'file'; tabId: string };

interface WorkspaceTabSelectionState {
  selectApp: (appId: string) => void;
  selectFile: (tabId: string) => void;
  selection: WorkspaceTabSelection;
}

const STORE_NAME = 'workspace-tab-selection.v1' as const;
const DEFAULT_SELECTION: WorkspaceTabSelection = {
  kind: 'app',
  appId: CONTEXT_EXPLORER_APP_ID,
};

const storage = createJSONStorage(() =>
  createSafeJsonStateStorage({ scope: 'WorkspaceTabSelectionStore' })
);

/**
 * Validate the persisted selection shape. localStorage can be tampered with from DevTools or
 * corrupted across versions — without this guard, `{ kind: 'file' }` (no tabId) would crash
 * any consumer reading `selection.tabId`. Falls back to the default on any malformed payload.
 */
function coerceSelection(value: unknown): WorkspaceTabSelection {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_SELECTION;
  }
  const candidate = value as Partial<WorkspaceTabSelection>;
  if (candidate.kind === 'file' && typeof candidate.tabId === 'string') {
    return { kind: 'file', tabId: candidate.tabId };
  }
  if (candidate.kind === 'app' && typeof candidate.appId === 'string') {
    return { kind: 'app', appId: candidate.appId };
  }
  return DEFAULT_SELECTION;
}

export const useWorkspaceTabSelectionStore = create<WorkspaceTabSelectionState>()(
  persist(
    (set) => ({
      selection: DEFAULT_SELECTION,
      selectApp: (appId) => set({ selection: { kind: 'app', appId } }),
      selectFile: (tabId) => set({ selection: { kind: 'file', tabId } }),
    }),
    {
      name: STORE_NAME,
      version: 1,
      storage,
      partialize: (s) => ({ selection: s.selection }),
      merge: (persisted, current) => {
        const ps = (persisted ?? {}) as { selection?: unknown };
        return { ...current, selection: coerceSelection(ps.selection) };
      },
    }
  )
);

/** Test-only helper to reset store and persisted value between tests. */
export function __resetWorkspaceTabSelectionStoreForTests(): void {
  useWorkspaceTabSelectionStore.setState({ selection: DEFAULT_SELECTION });
  const persistApi = (
    useWorkspaceTabSelectionStore as unknown as {
      persist?: { clearStorage?: () => void };
    }
  ).persist;
  persistApi?.clearStorage?.();
}
