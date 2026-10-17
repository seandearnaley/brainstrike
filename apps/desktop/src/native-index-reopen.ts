import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { NativeIndexEvent, NativeIndexReopen } from './native-index-lifecycle';

const logger = createLogger('NativeIndexReopen');

/** The wait before each automatic re-open, in order; their count bounds a series. */
export const NATIVE_INDEX_REOPEN_DELAYS_MS: readonly number[] = [2000, 10_000, 30_000];

/**
 * A failure its owner typed as passing: a missed deadline, or a process or index
 * that stopped and restarts. A refusal, bad input, configuration or an internal
 * fault needs a person, and is never re-opened automatically.
 */
export function isTransientFailure(error: unknown): boolean {
  return (
    error instanceof BoundaryFailureError &&
    error.failure.kind === 'fault' &&
    (error.failure.category === 'timeout' || error.failure.category === 'availability')
  );
}

/**
 * Records a generation's failures with the lifecycle owner. A startup failure
 * typed as transient also re-opens the same settings after the next delay, at
 * most once per delay in a row; the scheduled attempt rides the failure's cause,
 * so status shows it. A startup that completes ends the series.
 */
export function createNativeIndexFailures(options: {
  readonly delaysMs?: readonly number[] | undefined;
  readonly dispatch: (event: NativeIndexEvent) => Promise<unknown>;
  readonly onError: (operation: string, error: unknown) => void;
}) {
  const delays = options.delaysMs ?? NATIVE_INDEX_REOPEN_DELAYS_MS;
  let reopened = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const plan = (error: unknown): NativeIndexReopen | undefined => {
    if (!isTransientFailure(error)) {
      return;
    }
    if (reopened >= delays.length) {
      logger.error('Native index startup failed after its automatic re-opens; it stays blocked', {
        attempts: delays.length,
        error,
      });
      return;
    }
    reopened += 1;
    return { attempt: reopened, attempts: delays.length };
  };
  // Armed only once the failure is the owner's state, so the re-open meets that generation.
  const arm = (generation: number, reopen: NativeIndexReopen, error: unknown): void => {
    const delayMs = delays[reopen.attempt - 1] ?? 0;
    logger.warn('Native index startup failed; re-opening its settings', {
      ...reopen,
      delayMs,
      error,
    });
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      options
        .dispatch({ generation, kind: 'reopen' })
        .catch((failure: unknown) => options.onError('automatic re-open', failure));
    }, delayMs);
    timer.unref?.();
  };
  return {
    /** The index is closing for good: drop a scheduled re-open. */
    cancel(): void {
      clearTimeout(timer);
      timer = undefined;
    },
    record(generation: number, error: unknown, startup = false): void {
      const reopen = startup ? plan(error) : undefined;
      options
        .dispatch({
          error,
          generation,
          kind: 'failure',
          message: error instanceof Error ? error.message : String(error),
          ...(reopen ? { reopen } : {}),
        })
        .then(() => {
          if (reopen) {
            arm(generation, reopen, error);
          }
        })
        .catch((failure: unknown) => options.onError('failure observation', failure));
    },
    /** A generation's sources started: the next transient failure begins a new series. */
    started(): void {
      reopened = 0;
    },
  };
}
