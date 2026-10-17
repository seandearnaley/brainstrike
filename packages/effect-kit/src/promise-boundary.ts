import { Cause, Effect, Exit, type Tracer } from 'effect';

export interface PromiseBoundaryOptions {
  /**
   * Aborting interrupts the running effect (its finalizers run) and the
   * returned promise rejects with `signal.reason`.
   */
  readonly signal?: AbortSignal | undefined;
  /** Explicit tracing across a Promise edge; no ambient context or propagation headers. */
  readonly tracing?: {
    readonly tracer: Tracer.Tracer;
    readonly parentSpan?: Tracer.AnySpan;
  };
}

/**
 * Runs an Effect for a Promise-based caller: the one sanctioned way Effect code
 * hands a result back to code that is not itself Effect
 * (docs/agents/effect-boundary.md § "Promise and resource contracts").
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
  let program = effect;
  if (options.tracing) {
    program = program.pipe(Effect.withTracer(options.tracing.tracer));
    if (options.tracing.parentSpan) {
      program = program.pipe(Effect.withParentSpan(options.tracing.parentSpan));
    }
  }
  const exit = await Effect.runPromiseExit(program, { signal });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  if (signal?.aborted === true && interruptedFromOutside(exit.cause)) {
    throw signal.reason;
  }
  throw Cause.squash(exit.cause);
}

/**
 * True when the cause is only interruptions and the one that actually
 * interrupted the fiber came from outside any fiber, which is how the runner
 * records an abort of `signal`. A fiber that interrupts itself (or is
 * interrupted by another fiber) records that fiber's id instead.
 *
 * Only the FIRST recorded interrupt attributes the interruption; later ones are
 * incidental. Effect 4.0.1 began appending a second, fiberId-less reason for an
 * abort that lands while the fiber's finalizers already run (4.0.0 and the rc
 * line added none), so asking whether ANY reason is external would now report a
 * self-interruption as a caller abort and lose its error identity.
 */
function interruptedFromOutside(cause: Cause.Cause<unknown>): boolean {
  if (!Cause.hasInterruptsOnly(cause)) {
    return false;
  }
  for (const reason of cause.reasons) {
    if (Cause.isInterruptReason(reason)) {
      return reason.fiberId === undefined;
    }
  }
  return false;
}
