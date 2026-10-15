import { createContext, use } from 'react';

export interface ContextMapLinkValue {
  /** Show the Context workspace tab for the active thread (ADR-0021). */
  readonly openContextMap: () => void;
}

/**
 * Capability-injection seam for the composer popover's "Open context map"
 * link, parallel to `ChangesReviewContext`: app-shell renders
 * `<ContextMapLinkContext value={…}>` only when the Context workspace tab
 * exists (desktop), so web renders no link.
 */
export const ContextMapLinkContext = createContext<ContextMapLinkValue | null>(null);

/** The Context tab binding, or `null` when no provider supplied one. */
export function useContextMapLink(): ContextMapLinkValue | null {
  return use(ContextMapLinkContext);
}
