import { isConnectionLoss } from '@brainstrike/agent-host/boundary-wire';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';

/**
 * Process-wide "is the desktop app shutting down" flag.
 *
 * Background work that is torn down mid-flight during graceful shutdown (e.g.
 * native indexing whose embedding host is disposed) rejects with teardown errors
 * that are EXPECTED, not failures. Consumers read this flag to log such errors
 * at info instead of error and to skip alarming "failed" diagnostics.
 */
let shuttingDown = false;

/** Marked once at the start of graceful shutdown; never reset (the process exits). */
export function markDesktopShuttingDown(): void {
  shuttingDown = true;
}

export function isDesktopShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * ADR-0015: terminal quit cancels a factory reset's replacement startup and
 * profile reopen. Work waiting on that reopen ends with this refusal.
 */
export const RESET_REOPEN_CANCELLED = refusal({
  category: 'availability',
  code: 'desktop.reset-reopen-cancelled',
  message: 'The app is quitting, so the factory reset does not reopen the profile.',
});

/**
 * BST-2118: the desktop host lease owner's own close. A startup still in flight,
 * and every later acquisition from that owner, ends with this refusal.
 */
export const HOST_LEASE_CLOSED = refusal({
  category: 'availability',
  code: 'desktop.host-lease-closed',
  message: 'The agent host is closing.',
});

/** Recognizes that close by its code, never by message text. */
export function isHostLeaseClosed(error: unknown): boolean {
  return error instanceof BoundaryFailureError && error.failure.code === HOST_LEASE_CLOSED.code;
}

/**
 * Work refused because its owner retired: a closed native index, a host
 * connection that closed or was lost, a closed host lease owner, or a reset
 * reopen cancelled by quit.
 */
export function isRetirementRefusal(error: unknown): boolean {
  return (
    (error instanceof NativeIndexRefusalError && error.refusal.kind === 'closed') ||
    isConnectionLoss(error) ||
    isHostLeaseClosed(error) ||
    (error instanceof BoundaryFailureError && error.failure.code === RESET_REOPEN_CANCELLED.code)
  );
}

/**
 * ADR-0015: once the app is quitting, only that exact terminal cancellation is
 * expected, so its consumers log it at info. Outside shutdown it stays a failure.
 */
export function isExpectedShutdownRefusal(error: unknown): boolean {
  return shuttingDown && isRetirementRefusal(error);
}

/** Test-only: the production flag is never reset because the process exits. */
export function resetDesktopShutdownStateForTests(): void {
  shuttingDown = false;
}
