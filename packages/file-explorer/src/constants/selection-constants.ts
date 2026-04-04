/**
 * Selection Constants
 *
 * Shared constants for file selection operations to ensure consistency
 * across the codebase. These values are tuned for performance based on
 * empirical testing with large file trees (1,000+ files).
 *
 * @module selection-constants
 */

/**
 * Default chunk size for chunked selection operations.
 *
 * Files are processed in batches of this size with browser yielding between chunks.
 * This value balances UI responsiveness with processing efficiency:
 * - Too small: More overhead from yielding, slower overall
 * - Too large: Longer blocking periods, UI feels frozen
 *
 * The value 100 was chosen based on performance testing:
 * - Provides smooth 30+ fps during selection
 * - Completes 5,000 file selection in <3 seconds
 * - Works well with requestIdleCallback's 50ms deadline
 */
export const DEFAULT_SELECTION_CHUNK_SIZE = 100;

/**
 * Threshold above which to use chunked selection.
 *
 * For selections below this threshold, synchronous processing is faster
 * due to the overhead of chunking and yielding. Above this threshold,
 * chunking prevents UI freezes.
 */
export const CHUNKED_SELECTION_THRESHOLD = 100;

/**
 * Timeout for requestIdleCallback in milliseconds.
 *
 * This is the maximum time to wait for an idle period before forcing
 * the callback to run. A shorter timeout keeps the UI more responsive
 * but may cause more jank during heavy CPU usage.
 */
export const IDLE_CALLBACK_TIMEOUT_MS = 50;

/**
 * Sample size for logging file paths.
 *
 * When logging selection operations, only include this many sample paths
 * to avoid excessive log output for large selections.
 */
export const LOG_SAMPLE_SIZE = 3;

/**
 * Threshold above which full-result recursive selections should switch to
 * query-backed mode instead of materializing every selected file key.
 */
export const LARGE_SELECTION_QUERY_THRESHOLD = 500;

/**
 * Maximum number of relative paths to materialize for query-backed selections.
 *
 * These paths are used as a compatibility subset for preview, persistence UX,
 * and staged background indexing. The canonical selection remains the query
 * descriptor, not this subset.
 */
export const QUERY_SELECTION_MATERIALIZATION_LIMIT = 250;
