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
  appId: CONTEXT_EXPLORER_APP_ID,
  kind: 'app',
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
    return { appId: candidate.appId, kind: 'app' };
  }
  return DEFAULT_SELECTION;
}

export const useWorkspaceTabSelectionStore = create<WorkspaceTabSelectionState>()(
  persist(
    (set) => ({
      selectApp: (appId) => set({ selection: { appId, kind: 'app' } }),
      selectFile: (tabId) => set({ selection: { kind: 'file', tabId } }),
      selection: DEFAULT_SELECTION,
    }),
    {
      merge: (persisted, current) => {
        const ps = (persisted ?? {}) as { selection?: unknown };
        return { ...current, selection: coerceSelection(ps.selection) };
      },
      name: STORE_NAME,
      partialize: (s) => ({ selection: s.selection }),
      storage,
      version: 1,
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
