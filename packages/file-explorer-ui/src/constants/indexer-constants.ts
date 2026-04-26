/**
 * Background Token Indexer Constants
 *
 * Constants for adaptive debouncing and batching in the background token indexer.
 * These values are tuned to balance responsiveness with database efficiency.
 *
 * @module indexer-constants
 */

/**
 * Batch size thresholds for adaptive debouncing.
 *
 * Larger batches get longer debounce times to allow selection to stabilize.
 * This prevents thrashing during "select all" operations.
 */
export const LARGE_BATCH_THRESHOLD = 500;
export const MEDIUM_BATCH_THRESHOLD = 100;

/**
 * Debounce delays in milliseconds for different batch sizes.
 *
 * - Large batch (>500 files): Wait for chunked selection to complete
 * - Medium batch (100-500 files): Moderate wait for stability
 * - Small batch (<100 files): Quick response for interactive use
 */
export const LARGE_BATCH_DEBOUNCE_MS = 500;
export const MEDIUM_BATCH_DEBOUNCE_MS = 300;
export const SMALL_BATCH_DEBOUNCE_MS = 100;

/**
 * Maximum number of files to index in a single batch.
 *
 * Larger batches are split to avoid overwhelming the worker.
 */
export const INDEX_BATCH_SIZE = 50;

/**
 * Maximum number of file reads/resolutions to start before yielding.
 *
 * Electron IPC reads and web resolver calls run on foreground-sensitive
 * surfaces, so keep this intentionally small and deterministic.
 */
export const TOKEN_INDEXER_IO_BATCH_SIZE = 8;

/**
 * Frame-scale cooperative yield between non-final background indexing batches.
 */
export const TOKEN_INDEXER_BATCH_YIELD_MS = 16;

/**
 * Debounce delay for file handle map rebuild in milliseconds.
 *
 * Waits for the tree to stabilize before rebuilding the expensive
 * handle map. This avoids multiple rebuilds during expand-all operations.
 */
export const HANDLE_MAP_REBUILD_DEBOUNCE_MS = 500;

/**
 * Calculate adaptive debounce time based on batch size.
 *
 * Returns appropriate debounce delay for the given number of files,
 * using the threshold-based approach described above.
 */
export function getAdaptiveDebounceMs(fileCount: number): number {
  if (fileCount > LARGE_BATCH_THRESHOLD) {
    return LARGE_BATCH_DEBOUNCE_MS;
  }
  if (fileCount > MEDIUM_BATCH_THRESHOLD) {
    return MEDIUM_BATCH_DEBOUNCE_MS;
  }
  return SMALL_BATCH_DEBOUNCE_MS;
}
