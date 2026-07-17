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

export interface SectionSelectAllSummary {
  /** True when the section's scan stopped at the forest-union budget. */
  limitReached: boolean;
  /** Files selected in this section's pass. */
  selected: number;
}

export interface SectionTreeActions {
  cancelExpandAll: () => void;
  expandAll: () => Promise<void>;
  /**
   * Composite keys of the files currently DISPLAYED in this section (view
   * filters + quick filter applied) — what quick-filter Select All selects.
   */
  getVisibleQuickFilterKeys: () => string[];
  /** Section-scoped recursive select-all (quiet: no per-root toasts). */
  selectAll: () => Promise<SectionSelectAllSummary>;
}

export interface ForestSelectAllSummary {
  /** True when any section's scan stopped at the forest-union budget. */
  limitReached: boolean;
  /** Sections swept. */
  sections: number;
  /** Total files selected across all sections. */
  selected: number;
}

export interface ExpandAllProgress {
  loaded: number;
  total: number;
}

export interface ForestTreeActionsValue {
  /** Cancel every section's in-flight progressive expansion. */
  cancelExpandAll: () => void;
  /**
   * Composite keys of every file currently displayed across ALL sections
   * (view filters + quick filter applied) — the forest-wide source for
   * quick-filter Select All.
   */
  collectVisibleQuickFilterKeys: () => string[];
  /**
   * Aggregate expand-all progress: the sum of every section's latest report
   * for the CURRENT run (null before the first report). Values persist after
   * a run completes — consumers gate display on isExpandingAll — and reset
   * when the next run starts.
   */
  expandAllProgress: ExpandAllProgress | null;
  /** True while a forest-wide expand-all is running. */
  isExpandingAll: boolean;
  /** Register a section's actions; returns the unregister cleanup. */
  register: (rootId: string, actions: SectionTreeActions) => () => void;
  /**
   * Report a section's own expand progress. Sections push their tree
   * context's expandAllProgress here because it lives in per-root providers
   * the toolbar cannot see. Accepted at any time (section commits can trail
   * the run) — each run clears the aggregate at start and consumers gate
   * display on isExpandingAll.
   */
  reportExpandAllProgress: (rootId: string, progress: ExpandAllProgress) => void;
  /** Run expand-all across every registered section (sequentially). */
  runExpandAll: () => Promise<void>;
  /**
   * Run select-all across every registered section (sequentially). The
   * forest-union budget composes per section: each pass's scan cap shrinks
   * by what previous sections selected. The caller owns aggregate feedback
   * (sections run quiet).
   */
  runSelectAll: () => Promise<ForestSelectAllSummary>;
}

const ForestTreeActionsContext = createContext<ForestTreeActionsValue | null>(null);

export function ForestTreeActionsProvider({ children }: { children: ReactNode }) {
  const sectionsRef = useRef(new Map<string, SectionTreeActions>());
  const cancelledRef = useRef(false);
  const [runningCount, setRunningCount] = useState(0);
  // Lazily initialized (react-doctor rerender-lazy-ref-init): a useRef(new
  // Map()) initializer would allocate and discard a Map on every render.
  const progressByRootRef = useRef<Map<string, ExpandAllProgress> | null>(null);
  const [expandAllProgress, setExpandAllProgress] = useState<ExpandAllProgress | null>(null);

  const register = useCallback((rootId: string, actions: SectionTreeActions) => {
    sectionsRef.current.set(rootId, actions);
    return () => {
      if (sectionsRef.current.get(rootId) === actions) {
        sectionsRef.current.delete(rootId);
      }
    };
  }, []);

  const reportExpandAllProgress = useCallback((rootId: string, progress: ExpandAllProgress) => {
    // Deliberately ungated: section commits can trail the run's completion
    // (React batches under load), so a run-active gate would drop the very
    // reports it exists to collect. Staleness is handled elsewhere — each run
    // clears the map at start, and consumers gate display on isExpandingAll.
    if (progressByRootRef.current === null) {
      progressByRootRef.current = new Map<string, ExpandAllProgress>();
    }
    const progressByRoot = progressByRootRef.current;
    progressByRoot.set(rootId, progress);
    let loaded = 0;
    let total = 0;
    for (const sectionProgress of progressByRoot.values()) {
      loaded += sectionProgress.loaded;
      total += sectionProgress.total;
    }
    // Value-equal bailout: repeated reports of the same sums must not churn
    // context consumers with fresh object identities.
    setExpandAllProgress((previous) =>
      previous && previous.loaded === loaded && previous.total === total
        ? previous
        : { loaded, total }
    );
  }, []);

  const runExpandAll = useCallback(async () => {
    cancelledRef.current = false;
    // Fresh aggregate per run; completed runs keep their final counts only
    // until the next run starts (display is gated on isExpandingAll).
    progressByRootRef.current?.clear();
    setExpandAllProgress(null);
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

  const runSelectAll = useCallback(async (): Promise<ForestSelectAllSummary> => {
    const summary: ForestSelectAllSummary = { limitReached: false, sections: 0, selected: 0 };
    // Sequential on purpose: the forest-union budget composes pass by pass —
    // each section's scan cap already subtracts what previous sections
    // selected (computeSelectAllScanCap), so parallel passes would race the
    // budget.
    for (const [, actions] of Array.from(sectionsRef.current)) {
      summary.sections += 1;
      const result = await actions.selectAll();
      summary.selected += result.selected;
      summary.limitReached = summary.limitReached || result.limitReached;
      if (result.limitReached) {
        break;
      }
    }
    return summary;
  }, []);

  const collectVisibleQuickFilterKeys = useCallback((): string[] => {
    const keys: string[] = [];
    for (const [, actions] of sectionsRef.current) {
      keys.push(...actions.getVisibleQuickFilterKeys());
    }
    return keys;
  }, []);

  const value = useMemo(
    () => ({
      cancelExpandAll,
      collectVisibleQuickFilterKeys,
      expandAllProgress,
      isExpandingAll: runningCount > 0,
      register,
      reportExpandAllProgress,
      runExpandAll,
      runSelectAll,
    }),
    [
      cancelExpandAll,
      collectVisibleQuickFilterKeys,
      expandAllProgress,
      register,
      reportExpandAllProgress,
      runExpandAll,
      runningCount,
      runSelectAll,
    ]
  );

  return (
    <ForestTreeActionsContext.Provider value={value}>{children}</ForestTreeActionsContext.Provider>
  );
}

/** Null outside a ForestTreeActionsProvider (e.g. isolated tests). */
export function useOptionalForestTreeActions(): ForestTreeActionsValue | null {
  return useContext(ForestTreeActionsContext);
}
