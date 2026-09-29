import { Effect, Semaphore } from 'effect';
import { runAtPromiseBoundary } from './promise-boundary.js';

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
 * It bounds concurrency; it does NOT guarantee order. Waiting tasks wake in
 * arrival order, but a task that arrives while a permit is momentarily free
 * starts at once, ahead of waiters that have not woken yet. Code that needs
 * strict FIFO (a mutex whose callers rely on submission order) must not use
 * this (docs/agents/effect-boundary.md § "Shared helpers").
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
