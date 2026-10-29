import { Effect, Semaphore } from 'effect';
import { runAtPromiseBoundary } from './promise-boundary.ts';

export interface LimitedTaskOptions {
  /**
   * Aborting while the task waits for a permit drops it before it starts;
   * aborting while it runs aborts the signal handed to the task. Either way the
   * promise rejects with `signal.reason`.
   */
  readonly signal?: AbortSignal | undefined;
}

/** Runs a task once one of the limiter's permits is free. */
export type ConcurrencyLimiter = <T>(
  task: (signal: AbortSignal) => PromiseLike<T>,
  options?: LimitedTaskOptions
) => Promise<T>;

/**
 * Bounds how many tasks run at once. A settled task, fulfilled or rejected,
 * always returns its permit, and its value or rejection passes through
 * unchanged.
 *
 * Tasks start in arrival order: Effect's Semaphore serves waiters in
 * registration order and a new task does not start ahead of one already
 * waiting. Aborted waiters leave the queue without starting.
 */
export function createConcurrencyLimiter(permits: number): ConcurrencyLimiter {
  if (!(Number.isInteger(permits) && permits > 0)) {
    throw new RangeError(`createConcurrencyLimiter needs a positive integer; got ${permits}.`);
  }
  const semaphore = Semaphore.makeUnsafe(permits);
  return (task, options = {}) =>
    runAtPromiseBoundary(
      // The rejection passes through untyped on purpose: this helper returns it
      // to a Promise caller unchanged, so there is no error channel to type.
      // @effect-diagnostics-next-line unknownInEffectCatch:off
      semaphore.withPermits(1)(Effect.tryPromise({ catch: (error) => error, try: task })),
      { signal: options.signal }
    );
}
