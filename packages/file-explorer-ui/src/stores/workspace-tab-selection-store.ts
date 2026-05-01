import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { CONTEXT_EXPLORER_APP_ID } from '../workspace-app';

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

const storage = createJSONStorage(() => {
  // Mirrors the safe storage wrapper used by tab-manager-store: localStorage when available,
  // in-memory map otherwise (SSR, tests). Wrapped in try/catch only at the platform call sites
  // so storage outages surface as logged warnings rather than silent loss.
  const memory = new Map<string, string>();

  const fromLocalStorage = (key: string): string | null => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(key);
      }
    } catch {}
    return null;
  };

  const writeLocalStorage = (key: string, value: string): void => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
      }
    } catch {}
  };

  const removeLocalStorage = (key: string): void => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    } catch {}
  };

  return {
    getItem: (name: string) => fromLocalStorage(name) ?? memory.get(name) ?? null,
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
