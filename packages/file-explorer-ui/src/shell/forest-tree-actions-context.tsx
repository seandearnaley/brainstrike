/**
 * Forest Tree Actions registry.
 *
 * Toolbar-level tree actions (Expand All / Collapse All) live OUTSIDE the
 * per-root FileTreeProviders, but progressive expansion must run inside each
 * section's own tree context — routing it through the focused root's provider
 * silently expands the invisible panel tree (the recurring forest disease).
 *
 * Each RootSectionInner registers its section-scoped actions here — ABOVE the
 * section's collapse branch, so a collapsed section (pane unmounted) stays
 * registered and Expand All / Select All still reach it (BST-571). The panel
 * actions run them across every section, and section headers open/close
 * through each registration's setCollapsed.
 *
 * PERF SPLIT (PR #1734 audit): the registry callbacks are STABLE and live in
 * their own context, while the high-frequency expand-all progress aggregate is
 * an external store subscribed only by the toolbar's progress display through
 * `useForestExpandAllProgress`. Progress reports are coalesced through
 * requestAnimationFrame and the aggregate is maintained by per-section delta,
 * so a report neither re-renders every section pane nor re-sums every root.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
  /**
   * Open/close this root section's header (the whole section, not its
   * directories). Forest-wide Collapse All closes sections through this, and
   * runExpandAll opens each section as its sweep turn starts — expanding
   * directories underneath a closed header is invisible work.
   */
  setCollapsed: (collapsed: boolean) => void;
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

/**
 * STABLE registry value: every field keeps its identity for the provider's
 * lifetime. Progress observation deliberately lives OUTSIDE this value — use
 * `useForestExpandAllProgress` / `useForestIsExpandingAll` — so the sections
 * that only register/report never re-render on progress events.
 */
export interface ForestTreeActionsValue {
  /** Cancel every section's in-flight progressive expansion. */
  cancelExpandAll: () => void;
  /**
   * Close every registered root section's header. Directory expansion state
   * is NOT touched here — the panel's Collapse All clears the workspace
   * expansion set itself (single source of truth stays the store).
   */
  collapseAllSections: () => void;
  /**
   * Composite keys of every file currently displayed across ALL sections
   * (view filters + quick filter applied) — the forest-wide source for
   * quick-filter Select All.
   */
  collectVisibleQuickFilterKeys: () => string[];
  /** Register a section's actions; returns the unregister cleanup. */
  register: (rootId: string, actions: SectionTreeActions) => () => void;
  /**
   * Report a section's own expand progress. Sections push their tree
   * context's expandAllProgress here because it lives in per-root providers
   * the toolbar cannot see. Accepted at any time (section commits can trail
   * the run) — each run clears the aggregate at start and consumers gate
   * display on isExpandingAll. Reports are aggregated by DELTA against the
   * section's previous report and published once per animation frame.
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

interface ExpandAllProgressStore {
  getSnapshot: () => ExpandAllProgress | null;
  subscribe: (listener: () => void) => () => void;
}

/**
 * Observable run state. Kept separate from the actions value so subscribing
 * to it (toolbar) never churns the registry consumers: `isExpandingAll` flips
 * only at run boundaries, and the progress store's identity is stable (its
 * SNAPSHOT changes per coalesced frame, delivered via useSyncExternalStore).
 */
interface ForestExpandAllStateValue {
  isExpandingAll: boolean;
  progressStore: ExpandAllProgressStore;
}

const ForestTreeActionsContext = createContext<ForestTreeActionsValue | null>(null);
const ForestExpandAllStateContext = createContext<ForestExpandAllStateValue | null>(null);

// Provider-absent fallbacks (isolated tests / single-root layouts): stable
// no-op store so useSyncExternalStore's inputs keep their identities.
const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

export function ForestTreeActionsProvider({ children }: { children: ReactNode }) {
  const sectionsRef = useRef(new Map<string, SectionTreeActions>());
  const cancelledRef = useRef(false);
  const [runningCount, setRunningCount] = useState(0);
  // Lazily initialized (react-doctor rerender-lazy-ref-init): a useRef(new
  // Map()) initializer would allocate and discard a Map on every render.
  const progressByRootRef = useRef<Map<string, ExpandAllProgress> | null>(null);
  // Running aggregate, maintained by delta as sections report — never re-sums
  // every root on a report.
  const aggregateRef = useRef({ loaded: 0, total: 0 });
  // Published snapshot for useSyncExternalStore. Only replaced inside the
  // coalesced frame flush (or the synchronous run-start reset) and only when
  // the sums actually changed, so unchanged reports keep the object identity.
  const snapshotRef = useRef<ExpandAllProgress | null>(null);
  const listenersRef = useRef<Set<() => void> | null>(null);
  const frameRef = useRef<number | null>(null);

  const register = useCallback((rootId: string, actions: SectionTreeActions) => {
    sectionsRef.current.set(rootId, actions);
    return () => {
      if (sectionsRef.current.get(rootId) === actions) {
        sectionsRef.current.delete(rootId);
      }
    };
  }, []);

  const notifyProgressListeners = useCallback(() => {
    const listeners = listenersRef.current;
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener();
    }
  }, []);

  const flushProgress = useCallback(() => {
    frameRef.current = null;
    const { loaded, total } = aggregateRef.current;
    const previous = snapshotRef.current;
    // Value-equal bailout: repeated reports of the same sums must not churn
    // subscribers with fresh object identities.
    if (previous && previous.loaded === loaded && previous.total === total) {
      return;
    }
    snapshotRef.current = { loaded, total };
    notifyProgressListeners();
  }, [notifyProgressListeners]);

  const scheduleProgressFlush = useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = requestAnimationFrame(flushProgress);
  }, [flushProgress]);

  // Unmount-only cleanup: drop any pending coalesced flush.
  useEffect(() => {
    const cancelPendingFlush = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
    return cancelPendingFlush;
  }, []);

  const reportExpandAllProgress = useCallback(
    (rootId: string, progress: ExpandAllProgress) => {
      // Deliberately ungated: section commits can trail the run's completion
      // (React batches under load), so a run-active gate would drop the very
      // reports it exists to collect. Staleness is handled elsewhere — each
      // run clears the aggregate at start, and consumers gate display on
      // isExpandingAll.
      if (progressByRootRef.current === null) {
        progressByRootRef.current = new Map<string, ExpandAllProgress>();
      }
      const previous = progressByRootRef.current.get(rootId);
      progressByRootRef.current.set(rootId, progress);
      aggregateRef.current.loaded += progress.loaded - (previous?.loaded ?? 0);
      aggregateRef.current.total += progress.total - (previous?.total ?? 0);
      // Coalesce: bursts of reports publish at most once per animation frame.
      scheduleProgressFlush();
    },
    [scheduleProgressFlush]
  );

  const progressStore = useMemo<ExpandAllProgressStore>(
    () => ({
      getSnapshot: () => snapshotRef.current,
      subscribe: (listener: () => void) => {
        if (listenersRef.current === null) {
          listenersRef.current = new Set<() => void>();
        }
        const listeners = listenersRef.current;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    []
  );

  const runExpandAll = useCallback(async () => {
    cancelledRef.current = false;
    // Fresh aggregate per run; completed runs keep their final counts only
    // until the next run starts (display is gated on isExpandingAll). The
    // reset publishes SYNCHRONOUSLY — a stale previous-run count must never
    // survive into the new run's first frame.
    progressByRootRef.current?.clear();
    aggregateRef.current = { loaded: 0, total: 0 };
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (snapshotRef.current !== null) {
      snapshotRef.current = null;
      notifyProgressListeners();
    }
    setRunningCount((count) => count + 1);
    try {
      // Sequential: progressive expansion is I/O-heavy per root; one section
      // at a time keeps disk load and progress predictable (mirrors the
      // sequential per-root sync).
      for (const [, actions] of Array.from(sectionsRef.current)) {
        if (cancelledRef.current) {
          break;
        }
        // Open the section as its turn starts (not all upfront): the sweep is
        // sequential and I/O-heavy, so later roots stay closed until reached.
        actions.setCollapsed(false);
        await actions.expandAll();
      }
    } finally {
      setRunningCount((count) => count - 1);
    }
  }, [notifyProgressListeners]);

  const cancelExpandAll = useCallback(() => {
    cancelledRef.current = true;
    for (const [, actions] of sectionsRef.current) {
      actions.cancelExpandAll();
    }
  }, []);

  const collapseAllSections = useCallback(() => {
    for (const [, actions] of sectionsRef.current) {
      actions.setCollapsed(true);
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

  // Every dependency is a stable callback — this value NEVER changes identity,
  // so actions-only consumers (each PerRootTreePane, the panel's toolbar
  // callbacks) do not re-render on progress or run-state changes.
  const actionsValue = useMemo<ForestTreeActionsValue>(
    () => ({
      cancelExpandAll,
      collapseAllSections,
      collectVisibleQuickFilterKeys,
      register,
      reportExpandAllProgress,
      runExpandAll,
      runSelectAll,
    }),
    [
      cancelExpandAll,
      collapseAllSections,
      collectVisibleQuickFilterKeys,
      register,
      reportExpandAllProgress,
      runExpandAll,
      runSelectAll,
    ]
  );

  // Changes only at run boundaries (progress travels through the store).
  const expandAllStateValue = useMemo<ForestExpandAllStateValue>(
    () => ({ isExpandingAll: runningCount > 0, progressStore }),
    [runningCount, progressStore]
  );

  return (
    <ForestTreeActionsContext.Provider value={actionsValue}>
      <ForestExpandAllStateContext.Provider value={expandAllStateValue}>
        {children}
      </ForestExpandAllStateContext.Provider>
    </ForestTreeActionsContext.Provider>
  );
}

/** Null outside a ForestTreeActionsProvider (e.g. isolated tests). */
export function useOptionalForestTreeActions(): ForestTreeActionsValue | null {
  return useContext(ForestTreeActionsContext);
}

/** True while a forest-wide expand-all runs; false outside a provider. */
export function useForestIsExpandingAll(): boolean {
  return useContext(ForestExpandAllStateContext)?.isExpandingAll ?? false;
}

/**
 * The forest-wide expand-all progress aggregate (null before the first report
 * of a run, and outside a provider). Subscribes via useSyncExternalStore, so
 * ONLY the calling component re-renders — at most once per animation frame —
 * as sections report. Values persist after a run completes (consumers gate
 * display on useForestIsExpandingAll) and reset when the next run starts.
 */
export function useForestExpandAllProgress(): ExpandAllProgress | null {
  const store = useContext(ForestExpandAllStateContext)?.progressStore;
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? nullSnapshot
  );
}
