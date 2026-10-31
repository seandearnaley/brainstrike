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

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ExpandAllProgress,
  type ExpandAllProgressStore,
  ForestExpandAllStateContext,
  type ForestExpandAllStateValue,
  type ForestSelectAllSummary,
  ForestTreeActionsContext,
  type ForestTreeActionsValue,
  type SectionTreeActions,
} from './forest-tree-actions-context';

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
    const attempt = async () => {
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
    };
    return attempt().finally(() => {
      setRunningCount((count) => count - 1);
    });
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
