import { createLogger } from '@brainstrike/utils/logger';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { CONTEXT_EXPLORER_APP_ID } from '../workspace-app';

const logger = createLogger('WorkspaceTabSelectionStore');

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

  const writeLocalStorage = (key: string, value: string): boolean => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
        return true;
      }
    } catch (err) {
      // Quota exceeded, private-browsing, etc. — surface in logs so users who lose tab
      // selection on reload can find a root cause; the in-memory fallback below keeps
      // the current session working.
      logger.warn('localStorage.setItem failed; falling back to in-memory storage', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  };

  const removeLocalStorage = (key: string): void => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    } catch (err) {
      logger.warn('localStorage.removeItem failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    getItem: (name: string) => fromLocalStorage(name) ?? memory.get(name) ?? null,
    setItem: (name: string, value: string) => {
      const persisted = writeLocalStorage(name, value);
      if (!persisted) {
        memory.set(name, value);
      }
    },
    removeItem: (name: string) => {
      removeLocalStorage(name);
      memory.delete(name);
    },
  };
});

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
