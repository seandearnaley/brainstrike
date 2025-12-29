/**
 * Concurrency Utilities
 *
 * Helpers for managing concurrent async operations with limits.
 */

/**
 * Process items with limited concurrency.
 *
 * Processes items in chunks where each chunk runs in parallel,
 * but chunks are processed sequentially to limit concurrent operations.
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
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];

  // Process items in chunks of concurrency size
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }

  return results;
}
