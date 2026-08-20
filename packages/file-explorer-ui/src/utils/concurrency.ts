/**
 * Concurrency Utilities
 *
 * Helpers for managing concurrent async operations with limits.
 */

/**
 * Process items with limited concurrency.
 *
 * Runs a work-conserving pool: whenever one worker settles, it immediately
 * claims the next item without waiting for unrelated in-flight peers.
 *
 * @param items - Items to process
 * @param concurrency - Maximum number of concurrent operations
 * @param fn - Async function to apply to each item
 * @returns Array of results in the same order as input items
 *
 * @example
 * ```ts
 * const results = await runWithConcurrency(
 *   urls,
 *   5,
 *   async (url) => fetch(url).then(r => r.json())
 * );
 * ```
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (!(Number.isInteger(concurrency) && concurrency > 0)) {
    throw new RangeError('Concurrency must be a positive integer');
  }
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let failed = false;
  let firstError: unknown;
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!failed) {
        // Claim synchronously before awaiting: JavaScript execution cannot
        // interleave between the read and increment, so every worker receives
        // one unique index without a lock.
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        const item = items[index] as T;
        try {
          results[index] = await fn(item);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    })
  );

  if (failed) {
    throw firstError;
  }

  return results;
}
