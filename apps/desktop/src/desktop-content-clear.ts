import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { RESET_REOPEN_CANCELLED } from './desktop-shutdown-state';
import { indexConfigCause, isQuitTerminalRefusal } from './native-index-boundary-failure';

interface DesktopContentClearRuntime {
  readonly name: string;
  readonly stop: () => Promise<unknown>;
}

interface DesktopContentClearLogger {
  readonly debug: (message: string, error: unknown) => void;
  readonly error: (message: string, error: unknown) => void;
  readonly info: (message: string) => void;
}

interface DesktopContentClearCounts {
  readonly deletedChunks: number | null;
  readonly deletedFiles: number;
}

export interface CreateDesktopContentClearOptions {
  /** Terminal clear through the current host writer; retains configuration in place. */
  readonly clearRetainedContent: () => Promise<DesktopContentClearCounts>;
  /** Replaces the stale visible renderer and resolves only after its explicit
   * renderer-ready acknowledgement. MCP admission remains closed while this
   * promise is pending. Terminal quit cancels readiness through the signal. */
  readonly completeSuccessfulClear: (signal: AbortSignal) => Promise<void>;
  readonly logger: DesktopContentClearLogger;
  readonly resumeAfterClear: (
    outcome: 'failed' | 'succeeded',
    signal: AbortSignal
  ) => Promise<void>;
  /** The same Main transition queue owns retirement, clearing and reopen; the
   * owner retains its accepted request while waiting for this admission. */
  readonly runTransition: (
    work: () => Promise<DesktopContentClearResult>
  ) => Promise<DesktopContentClearResult>;
  readonly runtimes: readonly DesktopContentClearRuntime[];
}

interface DesktopContentClearResult {
  readonly deletedChunks?: number | null;
  readonly deletedFiles?: number;
  readonly message?: string;
  readonly success: boolean;
}

export interface DesktopContentClear {
  clear(): Promise<DesktopContentClearResult>;
  /** Joins an accepted clear with its original failure, cancels replacement
   * startup and refuses new clears. */
  close(): Promise<void>;
  /**
   * Settles once no clear is in flight, its reopen included. A clear retires the
   * profile only until it reopens it: whoever needs the profile meanwhile waits.
   */
  idle(): Promise<void>;
  /** The accepted clear, including its reopen or original failed outcome. */
  inFlight(): Promise<DesktopContentClearResult> | null;
}

type ClearFailure =
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'none' };

const NO_FAILURE: ClearFailure = { kind: 'none' };

function combineFailure(failure: unknown, resumeFailure: unknown): unknown {
  const clearMessage = failure instanceof Error ? failure.message : String(failure);
  const resumeMessage =
    resumeFailure instanceof Error ? resumeFailure.message : String(resumeFailure);
  return new AggregateError(
    [failure, resumeFailure],
    `${clearMessage}; content clear runtime resume failed: ${resumeMessage}`
  );
}

async function resumeAfter({
  cleared,
  failure,
  logger,
  rendererReplaced,
  resumeAfterClear,
  signal,
}: {
  readonly cleared: boolean;
  readonly failure: ClearFailure;
  readonly logger: DesktopContentClearLogger;
  readonly rendererReplaced: boolean;
  readonly resumeAfterClear: CreateDesktopContentClearOptions['resumeAfterClear'];
  readonly signal: AbortSignal;
}): Promise<ClearFailure> {
  if (signal.aborted || (cleared && !rendererReplaced)) {
    return failure;
  }
  try {
    await resumeAfterClear(cleared ? 'succeeded' : 'failed', signal);
    return failure;
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      return failure;
    }
    // BST-2278: quit fences profile admission before it cancels this reopen, so a reopen that
    // borrows the profile meanwhile gets quit's one terminal refusal (ADR-0026). The clear is
    // complete; quit retires what this would reopen.
    if (cleared && isQuitTerminalRefusal(indexConfigCause(error))) {
      logger.debug('Content clear complete; resume skipped because the app is quitting', error);
      return failure;
    }
    return {
      error: failure.kind === 'none' ? error : combineFailure(failure.error, error),
      kind: 'failed',
    };
  }
}

async function stopRuntimes(runtimes: readonly DesktopContentClearRuntime[]): Promise<void> {
  const results = await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [{ reason: result.reason, runtime: runtimes[index] }] : []
  );
  if (failures.length === 0) {
    return;
  }
  throw new AggregateError(
    failures.map(({ reason }) => reason),
    `Failed to stop desktop runtimes for the content clear: ${failures
      .map(({ runtime }) => runtime?.name)
      .join(', ')}`
  );
}

/**
 * Clear Database: retires what reads the profile, has the host clear its content and exit,
 * replaces the visible renderers, then reopens. Configuration and credentials stay. Factory
 * Reset is not this: it relaunches the app and wipes on the next start
 * (`factory-reset-relaunch.ts`).
 */
export function createDesktopContentClear({
  clearRetainedContent,
  completeSuccessfulClear,
  logger,
  resumeAfterClear,
  runtimes,
  runTransition,
}: CreateDesktopContentClearOptions): DesktopContentClear {
  const shutdown = new AbortController();
  const runClear = async (): Promise<DesktopContentClearResult> => {
    let counts: DesktopContentClearCounts | undefined;
    let failure: ClearFailure = NO_FAILURE;
    let cleared = false;
    let rendererReplaced = false;
    try {
      await stopRuntimes(runtimes);
      counts = await clearRetainedContent();
      cleared = true;
      if (!shutdown.signal.aborted) {
        await completeSuccessfulClear(shutdown.signal);
        rendererReplaced = !shutdown.signal.aborted;
      }
    } catch (error) {
      failure = { error, kind: 'failed' };
    }
    // A failed clear reopens what it retired. A successful one reopens only after the
    // replacement renderer reports ready. Terminal quit never reopens.
    failure = await resumeAfter({
      cleared,
      failure,
      logger,
      rendererReplaced,
      resumeAfterClear,
      signal: shutdown.signal,
    });
    if (failure.kind === 'failed') {
      logger.error('Failed to clear desktop content:', failure.error);
      throw failure.error;
    }
    logger.info('Desktop content clear completed');
    return { success: true, ...counts };
  };
  let inFlight: {
    readonly completion: Promise<DesktopContentClearResult>;
    readonly result: Promise<DesktopContentClearResult>;
  } | null = null;
  return {
    clear: () => {
      if (shutdown.signal.aborted) {
        return Promise.resolve({
          message: 'The app is quitting: the content clear did not start.',
          success: false,
        });
      }
      if (inFlight) {
        return inFlight.result;
      }
      let admitted = false;
      const completion = runTransition(() => {
        admitted = true;
        return runClear();
      });
      // Only the renderer boundary converts an accepted clear's rejection to a
      // result envelope. Terminal close joins its original completion.
      const result = completion
        .catch((error: unknown): DesktopContentClearResult => {
          if (!admitted) {
            throw error;
          }
          return {
            message: error instanceof Error ? error.message : String(error),
            success: false,
          };
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = { completion, result };
      return result;
    },
    // Quit joins an accepted clear but cancels replacement readiness and the reopen.
    close: async () => {
      shutdown.abort(new BoundaryFailureError(RESET_REOPEN_CANCELLED));
      await inFlight?.completion;
    },
    idle: async () => {
      while (inFlight) {
        await inFlight.result;
      }
    },
    inFlight: () => inFlight?.result ?? null,
  };
}
