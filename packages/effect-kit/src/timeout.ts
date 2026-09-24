import { Effect } from 'effect';
import { runAtPromiseBoundary } from './promise-boundary.js';

export interface TimeoutOptions {
  /** Builds the rejection value when the deadline passes. */
  readonly onTimeout: () => unknown;
  /** Aborting interrupts the task too; the promise then rejects with `signal.reason`. */
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds before the task is interrupted: a positive, finite number. */
  readonly timeoutMs: number;
}

/**
 * Runs `task` with a deadline. Replaces the `Promise.race(work, timer)` idiom,
 * which never cleared its timer and left the losing work running with no way
 * to learn it had lost.
 *
 * - The task settles first: its value or rejection passes through unchanged
 *   and the deadline timer is cleared.
 * - The deadline passes first: the `AbortSignal` handed to `task` aborts, so
 *   cooperative work stops, and the promise rejects with `onTimeout()`.
 * - The caller's `signal` aborts first: the task's signal aborts and the
 *   promise rejects with `signal.reason`.
 *
 * An invalid `timeoutMs` is reported as a rejected promise, like every other
 * outcome of this call; the factory `createConcurrencyLimiter` throws instead.
 */
export function runWithTimeout<T>(
  task: (signal: AbortSignal) => PromiseLike<T>,
  options: TimeoutOptions
): Promise<T> {
  const { onTimeout, signal, timeoutMs } = options;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return Promise.reject(
      new RangeError(`runWithTimeout needs a positive, finite timeoutMs; got ${timeoutMs}.`)
    );
  }
  // The rejection passes through untyped on purpose: this helper returns it
  // to a Promise caller unchanged, so there is no error channel to type.
  // @effect-diagnostics-next-line unknownInEffectCatch:off
  const program = Effect.tryPromise({ catch: (error) => error, try: task }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(onTimeout()),
    })
  );
  return runAtPromiseBoundary(program, { signal });
}
