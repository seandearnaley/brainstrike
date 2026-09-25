import { Cause, Effect, Exit } from 'effect';
import { runAtPromiseBoundary } from './promise-boundary.js';

export interface ShutdownStep {
  readonly name: string;
  /** The signal aborts when the sequence deadline passes while this step runs. */
  readonly run: (signal: AbortSignal) => PromiseLike<void> | void;
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
  /** Milliseconds for the whole sequence: a positive, finite number. */
  readonly deadlineMs: number;
  /** Clock for step durations; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /**
   * Called once if the deadline passes, AFTER the step still running was
   * interrupted (its signal aborted), with that step and its elapsed time.
   * Steps not yet started do not run.
   */
  readonly onDeadline: (inFlight: ShutdownStepInFlight | null) => void;
  /** Called after each step settles, in order, before the next step starts. */
  readonly onStepSettled?: ((outcome: ShutdownStepOutcome) => void) | undefined;
}

export interface ShutdownSequenceReport {
  /** Every step that settled, in order; an interrupted step is not listed. */
  readonly steps: readonly ShutdownStepOutcome[];
  readonly timedOut: boolean;
}

function validate(steps: readonly ShutdownStep[], deadlineMs: number): Error | null {
  if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) {
    return new RangeError(
      `runShutdownSequence needs a positive, finite deadlineMs; got ${deadlineMs}.`
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
 * Runs shutdown steps one at a time, in order, under ONE deadline.
 *
 * - A step that rejects or throws is recorded as `failed` and the next step
 *   still runs: one broken owner never skips a later owner's teardown.
 * - The deadline passes: the running step is interrupted (its `AbortSignal`
 *   aborts, so cooperative work stops), `onDeadline` receives that step and
 *   its elapsed time, and the remaining steps do not run. A caller that must
 *   exit anyway does so from `onDeadline`.
 *
 * Invalid options are reported as a rejected promise. A throw from
 * `onStepSettled` or `onDeadline` also rejects it.
 */
export function runShutdownSequence(
  steps: readonly ShutdownStep[],
  options: ShutdownSequenceOptions
): Promise<ShutdownSequenceReport> {
  const { deadlineMs, onDeadline, onStepSettled } = options;
  const invalid = validate(steps, deadlineMs);
  if (invalid) {
    return Promise.reject(invalid);
  }
  const now = options.now ?? Date.now;
  const settled: ShutdownStepOutcome[] = [];
  let inFlight: { readonly startedAt: number; readonly step: string } | null = null;

  const settle = (outcome: ShutdownStepOutcome): void => {
    inFlight = null;
    settled.push(outcome);
    onStepSettled?.(outcome);
  };

  const runStep = (step: ShutdownStep) =>
    Effect.suspend(() => {
      const startedAt = now();
      inFlight = { startedAt, step: step.name };
      // A step's rejection is recorded, never propagated, so its error type is
      // whatever the owner threw.
      // @effect-diagnostics-next-line unknownInEffectCatch:off
      const attempt = Effect.tryPromise({
        catch: (error) => error,
        try: async (signal) => {
          await step.run(signal);
        },
      });
      // Effect.exit keeps a failure as a value; interruption still propagates,
      // so an interrupted step is never recorded as settled.
      return Effect.exit(attempt).pipe(
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            const elapsedMs = now() - startedAt;
            settle(
              Exit.isSuccess(exit)
                ? { elapsedMs, outcome: 'succeeded', step: step.name }
                : { elapsedMs, error: Cause.squash(exit.cause), outcome: 'failed', step: step.name }
            );
          })
        )
      );
    });

  const program = Effect.forEach(steps, runStep, { discard: true }).pipe(
    Effect.as(false),
    Effect.timeoutOrElse({
      duration: deadlineMs,
      orElse: () =>
        Effect.sync(() => {
          const interrupted = inFlight;
          inFlight = null;
          onDeadline(
            interrupted
              ? { elapsedMs: now() - interrupted.startedAt, step: interrupted.step }
              : null
          );
          return true;
        }),
    })
  );

  return runAtPromiseBoundary(program).then((timedOut) => ({ steps: [...settled], timedOut }));
}
