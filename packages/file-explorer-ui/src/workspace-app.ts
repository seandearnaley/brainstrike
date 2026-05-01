import type { ComponentType, ReactNode } from 'react';

/**
 * A WorkspaceApp is a pinned, non-closable surface that lives in the workspace tab strip
 * alongside dynamic file tabs. It is the extensibility seam for plugging additional
 * "apps" (e.g. graph viewers, schedulers) into the editor area in the future.
 */
export interface WorkspaceApp {
  /** Lucide-compatible icon component rendered in the tab strip. */
  readonly icon: ComponentType<{ className?: string }>;
  /** Stable identifier used for selection persistence and tab addressing. */
  readonly id: string;
  /** Short label rendered next to the icon in the tab strip. */
  readonly label: string;
  /** Renders the app's body in the workspace area. */
  readonly render: () => ReactNode;
}

export const CONTEXT_EXPLORER_APP_ID = 'context-explorer';
