/**
 * Utility functions for backfill button disabled state logic
 */

/**
 * Determines if the backfill button should be disabled and provides user-facing explanation.
 *
 * Evaluates conditions in priority order, returning early when a disabled state is found.
 * This ensures the most critical blocking condition is always shown to the user.
 *
 * @param params - Configuration object with all required state
 * @param params.activeId - ID of the currently selected embedding set, or null if none selected
 * @param params.hasDb - Whether the database is ready and available
 * @param params.backfilling - Whether a backfill operation is currently in progress
 * @param params.isWeb - Whether running in web environment (vs Electron)
 * @param params.workerLocalRunning - Whether the local embedding worker is running
 * @param params.hasChunks - Whether there are chunks needing embeddings for the active set
 * @param params.queueCounts - Current queue statistics including running job count
 * @param params.queueCounts.running - Number of jobs currently being processed
 * @returns Object with disabled state and user-facing title explaining the reason
 *
 * @example
 * // Button enabled - all conditions met
 * const { disabled, title } = getBackfillDisabledState({
 *   activeId: 'set-1',
 *   hasDb: true,
 *   backfilling: false,
 *   isWeb: false,
 *   workerLocalRunning: true,
 *   hasChunks: true,
 *   queueCounts: { running: 0 }
 * });
 * // Returns: { disabled: false, title: 'Enqueue jobs for chunks missing embeddings...' }
 *
 * @example
 * // Button disabled - jobs currently running
 * const { disabled, title } = getBackfillDisabledState({
 *   activeId: 'set-1',
 *   hasDb: true,
 *   backfilling: false,
 *   isWeb: false,
 *   workerLocalRunning: true,
 *   hasChunks: true,
 *   queueCounts: { running: 2 }
 * });
 * // Returns: { disabled: true, title: 'Jobs are currently running – wait for completion' }
 *
 * @example
 * // Button disabled - no embedding set selected (highest priority check)
 * const { disabled, title } = getBackfillDisabledState({
 *   activeId: null,
 *   hasDb: true,
 *   backfilling: false,
 *   isWeb: false,
 *   workerLocalRunning: true,
 *   hasChunks: true,
 *   queueCounts: { running: 5 }
 * });
 * // Returns: { disabled: true, title: 'Select an active embedding set' }
 */
export function getBackfillDisabledState(params: {
  activeId: string | null;
  hasDb: boolean;
  backfilling: boolean;
  isWeb: boolean;
  workerLocalRunning: boolean;
  hasChunks: boolean;
  queueCounts: { running: number };
}): { disabled: boolean; title: string } {
  const { activeId, hasDb, backfilling, isWeb, workerLocalRunning, hasChunks, queueCounts } =
    params;
  // Evaluate reasons in priority order and early-return to keep complexity low
  if (!activeId) return { disabled: true, title: 'Select an active embedding set' };
  if (!hasDb) return { disabled: true, title: 'Database not ready yet' };
  if (backfilling) return { disabled: true, title: 'Backfilling in progress' };
  if (queueCounts.running > 0)
    return { disabled: true, title: 'Jobs are currently running – wait for completion' };
  if (isWeb && !workerLocalRunning)
    return { disabled: true, title: 'Start worker to enable backfill on Web' };
  return {
    disabled: false,
    title: hasChunks
      ? 'Enqueue jobs for chunks missing embeddings for the active set'
      : 'No pending chunks detected – you can still enqueue a backfill to double-check.',
  };
}
