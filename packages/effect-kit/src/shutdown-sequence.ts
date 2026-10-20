import { Cause, Effect, Exit } from 'effect';
import { runAtPromiseBoundary } from './promise-boundary.js';

export interface ShutdownStep {
  readonly name: string;
  readonly run: () => PromiseLike<void> | void;
}

export interface ShutdownStepInFlight {
  readonly elapsedMs: number;
  readonly step: string;
}

export type ShutdownStepOutcome =
  | { readonly elapsedMs: number; readonly outcome: 'succeeded'; readonly step: string }
  | {
      readonly elapsedMs: number;
      readonly error: unknown;
      readonly outcome: 'failed';
      readonly step: string;
    };

export interface ShutdownSequenceOptions {
  /** Clock for step durations; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /**
   * Log only: called once for a step still running `slowAfterMs` after it started, with that
   * step and its elapsed time. The sequence keeps waiting for the step and runs every later one.
   */
  readonly onSlow?: ((inFlight: ShutdownStepInFlight) => void) | undefined;
  /** Called after each step settles, in order, before the next step starts. */
  readonly onStepSettled?: ((outcome: ShutdownStepOutcome) => void) | undefined;
  /** When `onSlow` names a running step: a positive, finite number of milliseconds. */
  readonly slowAfterMs?: number | undefined;
}

export interface ShutdownSequenceReport {
  /** Every step, in order: each one runs until it settles. */
  readonly steps: readonly ShutdownStepOutcome[];
}

/** The options error to reject with, or null: a bad slow report, or empty or duplicate step names. */
function validate(steps: readonly ShutdownStep[], options: ShutdownSequenceOptions): Error | null {
  const { onSlow, slowAfterMs } = options;
  if ((onSlow === undefined) !== (slowAfterMs === undefined)) {
    return new TypeError('runShutdownSequence takes onSlow and slowAfterMs together.');
  }
  if (slowAfterMs !== undefined && !(Number.isFinite(slowAfterMs) && slowAfterMs > 0)) {
    return new RangeError(
      `runShutdownSequence needs a positive, finite slowAfterMs; got ${slowAfterMs}.`
    );
  }
  const seen = new Set<string>();
  for (const { name } of steps) {
    if (name.trim() === '' || seen.has(name)) {
      return new TypeError(`Shutdown step names must be non-empty and unique; got "${name}".`);
    }
    seen.add(name);
  }
  return null;
}

/**
 * Names `step` once through `onSlow` if it is still running after `slowAfterMs`. The returned
 * disarm runs when the step settles, so the report never outlives its step. A throw from
 * `onSlow` is kept for `failed`, never thrown from the timer.
 */
function armSlowReport(
  options: ShutdownSequenceOptions,
  step: string,
  startedAt: number,
  now: () => number,
  failed: (error: unknown) => void
): () => void {
  const { onSlow, slowAfterMs } = options;
  if (onSlow === undefined || slowAfterMs === undefined) {
    return () => undefined;
  }
  const timer = setTimeout(() => {
    try {
      onSlow({ elapsedMs: now() - startedAt, step });
    } catch (error) {
      failed(error);
    }
  }, slowAfterMs);
  return () => clearTimeout(timer);
}

/**
 * Runs shutdown steps one at a time, in order, each until it settles. There is
 * no deadline: a slow step is waited for, never abandoned, so a later step (a
 * physical native join, say) is never skipped (ADR-0026 R4).
 *
 * - A step that rejects or throws is recorded as `failed` and the next step
 *   still runs: one broken owner never skips a later owner's teardown.
 * - A step still running `slowAfterMs` after it started is named once through
 *   `onSlow`; that is a log, and the sequence keeps waiting for it.
 *
 * Invalid options are reported as a rejected promise. A throw from
 * `onStepSettled`, or from `onSlow` once its step settles, also rejects it: the
 * orchestration itself is broken.
 */
export function runShutdownSequence(
  steps: readonly ShutdownStep[],
  options: ShutdownSequenceOptions = {}
): Promise<ShutdownSequenceReport> {
  const invalid = validate(steps, options);
  if (invalid) {
    return Promise.reject(invalid);
  }
  const now = options.now ?? Date.now;
  const settled: ShutdownStepOutcome[] = [];

  const runStep = (step: ShutdownStep) =>
    Effect.suspend(() => {
      const startedAt = now();
      let slowReportFailure: { readonly error: unknown } | undefined;
      const disarm = armSlowReport(options, step.name, startedAt, now, (error) => {
        slowReportFailure = { error };
      });
      // A step's rejection is recorded, never propagated, so its error type is
      // whatever the owner threw.
      // @effect-diagnostics-next-line unknownInEffectCatch:off
      const attempt = Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await step.run();
        },
      });
      // Effect.exit keeps a failure as a value: every step settles and is recorded.
      return Effect.exit(attempt).pipe(
        Effect.ensuring(Effect.sync(disarm)),
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            const elapsedMs = now() - startedAt;
            const outcome: ShutdownStepOutcome = Exit.isSuccess(exit)
              ? { elapsedMs, outcome: 'succeeded', step: step.name }
              : { elapsedMs, error: Cause.squash(exit.cause), outcome: 'failed', step: step.name };
            settled.push(outcome);
            options.onStepSettled?.(outcome);
            if (slowReportFailure) {
              throw slowReportFailure.error;
            }
          })
        )
      );
    });

  const program = Effect.forEach(steps, runStep, { discard: true });
  return runAtPromiseBoundary(program).then(() => ({ steps: [...settled] }));
}
