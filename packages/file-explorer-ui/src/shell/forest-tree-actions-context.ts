/**
 * Forest Tree Actions registry contracts and consumer hooks.
 *
 * The Provider component lives in `forest-tree-actions-provider.tsx` so that
 * its module remains a component-only Fast Refresh boundary. Keep contexts,
 * hooks, and plain contracts in this `.ts` module, following the Explorer
 * columns provider/context split.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';

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

export interface ExpandAllProgressStore {
  getSnapshot: () => ExpandAllProgress | null;
  subscribe: (listener: () => void) => () => void;
}

/**
 * Observable run state. Kept separate from the actions value so subscribing
 * to it (toolbar) never churns the registry consumers: `isExpandingAll` flips
 * only at run boundaries, and the progress store's identity is stable (its
 * SNAPSHOT changes per coalesced frame, delivered via useSyncExternalStore).
 */
export interface ForestExpandAllStateValue {
  isExpandingAll: boolean;
  progressStore: ExpandAllProgressStore;
}

export const ForestTreeActionsContext = createContext<ForestTreeActionsValue | null>(null);
export const ForestExpandAllStateContext = createContext<ForestExpandAllStateValue | null>(null);

// Provider-absent fallbacks (isolated tests / single-root layouts): stable
// no-op store so useSyncExternalStore's inputs keep their identities.
const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

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
