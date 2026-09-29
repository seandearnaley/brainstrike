import type { ComponentType, CSSProperties, ReactNode } from 'react';

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
   * Where the tab sits in the workspace strip. `pinned`: the non-scrolling,
   * never-reordered group of singleton surfaces (Files, Changes, Canvas, …),
   * in registry order. `dynamic`: scrolls ahead of the file tabs (child
   * conversations). Required so a new app cannot forget to choose.
   */
  readonly placement: 'dynamic' | 'pinned';
  /**
   * Renders the app's body in the workspace area.
   *
   * Contract: this function is invoked on every host re-render, inside the panel's
   * error boundary (not behind a memoization boundary), so it should be cheap and
   * idempotent — typically just `() => <SomeComponent />`. React reconciles the
   * same element type across calls, so a stable component identity inside
   * `render()` avoids remounts; if your app needs expensive setup, do it inside
   * that component (with `useEffect`/`useMemo`) rather than in `render()` itself.
   */
  readonly render: () => ReactNode;
  /** Optional identity tint for an app that represents a colored conversation. */
  readonly tabAppearance?: {
    readonly accentClassName: string;
    readonly colorId: string;
    readonly idleClassName: string;
    readonly markClassName?: string;
    readonly selectedClassName: string;
    readonly style?: CSSProperties;
  };
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
