/**
 * Forest Tree Actions registry.
 *
 * Toolbar-level tree actions (Expand All / Collapse All) live OUTSIDE the
 * per-root FileTreeProviders, but progressive expansion must run inside each
 * section's own tree context — routing it through the focused root's provider
 * silently expands the invisible panel tree (the recurring forest disease).
 *
 * Each PerRootTreePane registers its section-scoped actions here; the panel
 * toolbar runs them across every section.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface SectionTreeActions {
  cancelExpandAll: () => void;
  expandAll: () => Promise<void>;
}

export interface ForestTreeActionsValue {
  /** Cancel every section's in-flight progressive expansion. */
  cancelExpandAll: () => void;
  /** True while a forest-wide expand-all is running. */
  isExpandingAll: boolean;
  /** Register a section's actions; returns the unregister cleanup. */
  register: (rootId: string, actions: SectionTreeActions) => () => void;
  /** Run expand-all across every registered section (sequentially). */
  runExpandAll: () => Promise<void>;
}

const ForestTreeActionsContext = createContext<ForestTreeActionsValue | null>(null);

export function ForestTreeActionsProvider({ children }: { children: ReactNode }) {
  const sectionsRef = useRef(new Map<string, SectionTreeActions>());
  const cancelledRef = useRef(false);
  const [runningCount, setRunningCount] = useState(0);

  const register = useCallback((rootId: string, actions: SectionTreeActions) => {
    sectionsRef.current.set(rootId, actions);
    return () => {
      if (sectionsRef.current.get(rootId) === actions) {
        sectionsRef.current.delete(rootId);
      }
    };
  }, []);

  const runExpandAll = useCallback(async () => {
    cancelledRef.current = false;
    setRunningCount((count) => count + 1);
    try {
      // Sequential: progressive expansion is I/O-heavy per root; one section
      // at a time keeps disk load and progress predictable (mirrors the
      // sequential per-root sync).
      for (const [, actions] of Array.from(sectionsRef.current)) {
        if (cancelledRef.current) {
          break;
        }
        await actions.expandAll();
      }
    } finally {
      setRunningCount((count) => count - 1);
    }
  }, []);

  const cancelExpandAll = useCallback(() => {
    cancelledRef.current = true;
    for (const [, actions] of sectionsRef.current) {
      actions.cancelExpandAll();
    }
  }, []);

  const value = useMemo(
    () => ({
      cancelExpandAll,
      isExpandingAll: runningCount > 0,
      register,
      runExpandAll,
    }),
    [cancelExpandAll, register, runExpandAll, runningCount]
  );

  return (
    <ForestTreeActionsContext.Provider value={value}>{children}</ForestTreeActionsContext.Provider>
  );
}

/** Null outside a ForestTreeActionsProvider (e.g. isolated tests). */
export function useOptionalForestTreeActions(): ForestTreeActionsValue | null {
  return useContext(ForestTreeActionsContext);
}
