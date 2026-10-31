import type { BoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';

/**
 * Classifier for main-process failures that mean "the workspace root has not
 * landed in the DB yet", not "the operation is broken": right after boot (or a
 * renderer reload) a root-scoped surface (such as the terminal) can issue its
 * first request BEFORE roots reconciliation has written the workspace row, and
 * the main process answers with one of these. Such failures are retried
 * silently for a bounded window instead of surfacing a dead error state.
 *
 * The codes are refused by apps/desktop/src/workspace-root-cwd.ts.
 */
const TRANSIENT_ROOT_CODES: ReadonlySet<string> = new Set([
  'workspace.root-unknown',
  'workspace.roots-unavailable',
]);

/** Delay between silent retries of a transient root-resolution failure. */
export const TRANSIENT_ROOT_RETRY_DELAY_MS = 300;

/** Bounded retry budget (~6s) before the failure surfaces as a real error. */
export const TRANSIENT_ROOT_RETRY_LIMIT = 20;

export function isTransientRootError(failure: BoundaryFailure): boolean {
  return TRANSIENT_ROOT_CODES.has(failure.code);
}
