import { isConnectionLoss } from '@brainstrike/agent-host/boundary-wire';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';

/**
 * Process-wide "is the desktop app shutting down" flag.
 *
 * Background work that is torn down mid-flight during graceful shutdown (e.g.
 * a host request whose connection closes) rejects with teardown errors that are
 * EXPECTED, not failures. Consumers read this flag to log such errors
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
 * ADR-0026: quit's one terminal reason. Profile admission refuses every borrow with it once
 * quit has fenced the profile, including one still waiting for the host's start-up.
 */
export const PROFILE_CLOSED_FOR_QUIT = refusal({
  category: 'availability',
  code: 'desktop.profile-closed',
  message: 'The app is quitting, so the agent host does not start.',
});

/** ADR-0015: a reset retired the profile; borrows are refused until it reopens the profile. */
export const PROFILE_CLOSED_FOR_RESET = refusal({
  category: 'availability',
  code: 'desktop.profile-resetting',
  message: 'Local data is being reset.',
  remedy: 'Try again once the reset finishes.',
});

/** Quit's terminal refusal, classified by its code, never by message text. */
export function isQuitTerminalRefusal(error: unknown): boolean {
  return (
    error instanceof BoundaryFailureError && error.failure.code === PROFILE_CLOSED_FOR_QUIT.code
  );
}

/**
 * BST-2285 (ADR-0026 R2): the renderer ended before it acknowledged its close preparation. Its
 * channel closed, its frame could take no message, its process exited or its window closed. A
 * signal to Main's process group ends the renderers with Main, so under quit this is a
 * retirement; outside quit it stays a failure. Defined here,
 * in the module the build shares between Main's bundles, so it has one class identity.
 */
export class RendererExitedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RendererExitedError';
  }
}

/**
 * Work refused because its owner retired: a closed host profile, a host
 * connection that closed or was lost, a renderer that ended before acknowledging
 * its close preparation, a closed host lease owner, or a reset reopen cancelled
 * by quit.
 */
export function isRetirementRefusal(error: unknown): boolean {
  return (
    isQuitTerminalRefusal(error) ||
    (error instanceof BoundaryFailureError &&
      error.failure.code === PROFILE_CLOSED_FOR_RESET.code) ||
    isConnectionLoss(error) ||
    // BST-2285: the same signal ends the renderers before their unload ACK.
    error instanceof RendererExitedError ||
    isHostLeaseClosed(error) ||
    (error instanceof BoundaryFailureError &&
      error.failure.kind === 'refusal' &&
      error.failure.code === 'host.closing') ||
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
