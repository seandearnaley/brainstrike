import { isConnectionLoss } from '@brainstrike/agent-host/boundary-wire';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import { IndexerError } from '@brainstrike/indexer';
import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import { SqliteQueryProcessExitedError } from '@brainstrike/sqlite-query';
import { isDesktopShuttingDown, resetDesktopShuttingDownForTests } from './desktop-shutdown-flag';

export { isDesktopShuttingDown, markDesktopShuttingDown } from './desktop-shutdown-flag';

/** Factory resets and content clears that are retiring the profile's host on purpose. */
let resetsRetiringProfile = 0;

/**
 * Runs a reset that retires the profile's host. While it runs, work its retirement ends
 * (a request the closed host never answered) is that reset's expected outcome, as under quit.
 */
export async function whileResetRetiresProfile<T>(reset: () => Promise<T>): Promise<T> {
  resetsRetiringProfile += 1;
  try {
    return await reset();
  } finally {
    resetsRetiringProfile -= 1;
  }
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
 * BST-2285 (ADR-0026 R2): the renderer ended before it acknowledged its close preparation. Its
 * channel closed, its frame could take no message, its process exited or its window closed. A
 * signal to Main's process group ends the renderers with Main, so under quit this is a
 * retirement, like the indexer's exit (BST-2192); outside quit it stays a failure. Defined here,
 * in the module the build shares between Main's bundles, so it has one class identity.
 */
export class RendererExitedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RendererExitedError';
  }
}

/**
 * Work refused because its owner retired: a closed native index, a host
 * connection that closed or was lost, an indexer or SQLite query process that
 * exited under the call, a renderer that ended before acknowledging its close
 * preparation, a closed host lease owner, or a reset reopen cancelled by quit.
 */
export function isRetirementRefusal(error: unknown): boolean {
  return (
    (error instanceof NativeIndexRefusalError && error.refusal.kind === 'closed') ||
    isConnectionLoss(error) ||
    // BST-2192: a signal to Main's process group ends the indexer and the SQLite query
    // process under in-flight calls.
    (error instanceof IndexerError && error.code === 'indexer-exited') ||
    error instanceof SqliteQueryProcessExitedError ||
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
 * ADR-0015: once the app is quitting, or while a reset retires the profile, only that
 * exact retirement is expected, so its consumers log it at info. Otherwise it stays a failure.
 */
export function isExpectedShutdownRefusal(error: unknown): boolean {
  return (isDesktopShuttingDown() || resetsRetiringProfile > 0) && isRetirementRefusal(error);
}

/** Test-only: the production flag is never reset because the process exits. */
export function resetDesktopShutdownStateForTests(): void {
  resetDesktopShuttingDownForTests();
  resetsRetiringProfile = 0;
}
