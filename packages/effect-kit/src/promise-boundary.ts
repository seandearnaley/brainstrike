import { Cause, Effect, Exit } from 'effect';

export interface PromiseBoundaryOptions {
  /**
   * Aborting interrupts the running effect (its finalizers run) and the
   * returned promise rejects with `signal.reason`.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Runs an Effect for a Promise-based caller: the one sanctioned way Effect code
 * hands a result back to code that is not itself Effect
 * (docs/agents/effect-boundary.md § "Promise boundaries").
 *
 * - Success resolves with the value.
 * - An expected failure rejects with the failure value itself, so a tagged
 *   error keeps its class and `instanceof` checks keep working.
 * - A defect rejects with the thrown value.
 * - An interruption caused by `signal` rejects with `signal.reason`, so callers
 *   that already test for an `AbortError` see the same error they always did.
 *   Effect's own runner rejects with a generic interruption error instead.
 *   An interruption the effect started itself keeps its own error, even if the
 *   signal aborts while its finalizers run.
 * - An already-aborted `signal` rejects before the effect starts. Effect's own
 *   runner still runs a synchronous effect to completion in that case.
 */
export async function runAtPromiseBoundary<A, E>(
  effect: Effect.Effect<A, E>,
  options: PromiseBoundaryOptions = {}
): Promise<A> {
  const { signal } = options;
  signal?.throwIfAborted();
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  if (signal?.aborted === true && interruptedFromOutside(exit.cause)) {
    throw signal.reason;
  }
  throw Cause.squash(exit.cause);
}

/**
 * True when the cause is only interruptions and one of them came from outside
 * any fiber, which is how the runner records an abort of `signal`. A fiber
 * that interrupts itself (or is interrupted by another fiber) records that
 * fiber's id instead.
 */
function interruptedFromOutside(cause: Cause.Cause<unknown>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) &&
    cause.reasons.some((reason) => Cause.isInterruptReason(reason) && reason.fiberId === undefined)
  );
}
