/**
 * Classifier for main-process errors that mean "the workspace root has not
 * landed in the DB yet", not "the operation is broken": right after boot (or a
 * renderer reload) a root-scoped surface (git panel, terminal) can issue its
 * first request BEFORE roots reconciliation has written the workspace row, and
 * the main process answers with one of these. Such failures are retried
 * silently for a bounded window instead of surfacing a dead error state.
 *
 * The strings are produced by apps/desktop/src/workspace-root-cwd.ts — keep
 * the prefixes in sync with that file.
 */
const TRANSIENT_ROOT_ERROR_PREFIXES = [
  'No open folder matches root id',
  'Workspace roots are unavailable.',
] as const;

/** Delay between silent retries of a transient root-resolution failure. */
export const TRANSIENT_ROOT_RETRY_DELAY_MS = 300;

/** Bounded retry budget (~6s) before the failure surfaces as a real error. */
export const TRANSIENT_ROOT_RETRY_LIMIT = 20;

export function isTransientRootError(message: string): boolean {
  return TRANSIENT_ROOT_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}
