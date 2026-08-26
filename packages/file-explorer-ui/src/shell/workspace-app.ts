import type { ComponentType, ReactNode } from 'react';

/**
 * A WorkspaceApp is a closable SINGLETON surface that lives in the workspace tab
 * strip alongside dynamic file tabs (BST-1258): at most one tab per app, opening
 * an open app activates it, closing reveals the launcher when nothing remains.
 * It is the extensibility seam for plugging additional "apps" (e.g. graph
 * viewers, schedulers) into the workspace in the future.
 */
export interface WorkspaceApp {
  /** Lucide-compatible icon component rendered in the tab strip. */
  readonly icon: ComponentType<{ className?: string }>;
  /** Stable identifier used for selection persistence and tab addressing. */
  readonly id: string;
  /** Short label rendered next to the icon in the tab strip. */
  readonly label: string;
  /**
   * Renders the app's body in the workspace area.
   *
   * Contract: this function is invoked inline on every host re-render (not behind a
   * memoization boundary), so it should be cheap and idempotent — typically just
   * `() => <SomeComponent />`. React reconciles the same element type across calls,
   * so a stable component identity inside `render()` avoids remounts; if your app
   * needs expensive setup, do it inside that component (with `useEffect`/`useMemo`)
   * rather than in `render()` itself.
   */
  readonly render: () => ReactNode;
}

export const CONTEXT_EXPLORER_APP_ID = 'context-explorer';
/**
 * Registry ids for the optional workspace apps. `WorkspaceApp.id` doubles as a
 * DOM id and a persistence key (`openAppIds`), so renames must be type errors,
 * not string drift that quietly accumulates in persisted state.
 */
export const CHANGES_APP_ID = 'changes';
export const CANVAS_APP_ID = 'canvas';
export const TERMINAL_APP_ID = 'terminal';
export const WORKTREE_MAP_APP_ID = 'worktree-map';
