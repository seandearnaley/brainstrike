/**
 * Utility functions for backfill button disabled state logic
 */

/**
 * Determines if the backfill button should be disabled and provides user-facing explanation.
 *
 * **Priority-ordered checks** (early returns ensure most critical condition shown first):
 * 1. No active embedding set selected
 * 2. Database not ready
 * 3. Backfill already in progress
 * 4. Jobs currently queued or running
 * 5. All chunks already embedded for active set
 *
 * **Web platform behavior note**:
 * The backfill button is enabled on web even without a worker running, allowing users to
 * enqueue jobs. However, jobs will not auto-process until the worker starts or until
 * brainstrike-42 is resolved (add database poller for pqueue fallback).
 *
 * @param params - Configuration object with all required state
 * @param params.activeId - ID of the currently selected embedding set, or null if none selected
 * @param params.hasDb - Whether the database is ready and available
 * @param params.backfilling - Whether a backfill operation is currently in progress
 * @param params.coverage - Embedding coverage statistics for the active set
 * @param params.coverage.total - Total number of chunks in database
 * @param params.coverage.withSet - Number of chunks with embeddings for active set
 * @param params.queueCounts - Current queue statistics including queued and running job counts
 * @param params.queueCounts.queued - Number of jobs waiting to be processed
 * @param params.queueCounts.running - Number of jobs currently being processed
 * @returns Object with disabled state and user-facing title explaining the reason
 *
 * @example
 * // Desktop/Web after fresh import - 0 embedded → ENABLED (user needs to start embedding)
 * const { disabled, title } = getBackfillDisabledState({
 *   activeId: 'set-1',
 *   hasDb: true,
 *   backfilling: false,
 *   coverage: { total: 148, withSet: 0 },
 *   queueCounts: { queued: 0, running: 0 }
 * });
 * // Returns: { disabled: false, title: 'Enqueue jobs for chunks missing embeddings...' }
 *
 * @example
 * // Desktop/Web with complete coverage - 148/148 → DISABLED (nothing to embed)
 * const { disabled, title } = getBackfillDisabledState({
 *   activeId: 'set-1',
 *   hasDb: true,
 *   backfilling: false,
 *   coverage: { total: 148, withSet: 148 },
 *   queueCounts: { queued: 0, running: 0 }
 * });
 * // Returns: { disabled: true, title: 'All chunks already embedded for active set' }
 *
 * @example
 * // Any platform with jobs running → DISABLED (prevent duplicate enqueues)
 * const { disabled, title } = getBackfillDisabledState({
 *   activeId: 'set-1',
 *   hasDb: true,
 *   backfilling: false,
 *   coverage: { total: 148, withSet: 0 },
 *   queueCounts: { queued: 5, running: 2 }
 * });
 * // Returns: { disabled: true, title: 'Jobs are queued or running – wait for completion' }
 *
 * @example
 * // Empty database → ENABLED (allows enqueue even with no chunks for validation)
 * const { disabled, title } = getBackfillDisabledState({
 *   activeId: 'set-1',
 *   hasDb: true,
 *   backfilling: false,
 *   coverage: { total: 0, withSet: 0 },
 *   queueCounts: { queued: 0, running: 0 }
 * });
 * // Returns: { disabled: false, title: 'No pending chunks detected – you can still enqueue...' }
 */
export function getBackfillDisabledState(params: {
  activeId: string | null;
  hasDb: boolean;
  unavailableReason?: string | undefined;
  backfilling: boolean;
  coverage: { total: number; withSet: number };
  queueCounts: { queued: number; running: number };
}): { disabled: boolean; title: string } {
  const { activeId, hasDb, unavailableReason, backfilling, coverage, queueCounts } = params;
  // Evaluate reasons in priority order and early-return to keep complexity low
  if (!activeId) {
    return { disabled: true, title: 'Select an active embedding set' };
  }
  if (!hasDb) {
    return { disabled: true, title: unavailableReason ?? 'Database not ready yet' };
  }
  if (backfilling) {
    return { disabled: true, title: 'Backfilling in progress' };
  }
  if (queueCounts.running > 0 || queueCounts.queued > 0) {
    return { disabled: true, title: 'Jobs are queued or running – wait for completion' };
  }

  // Disable when all chunks already embedded
  if (coverage.total > 0 && coverage.withSet >= coverage.total) {
    return { disabled: true, title: 'All chunks already embedded for active set' };
  }

  // Enable when chunks need embeddings (works on web even without worker - falls back to pqueue)
  const needsEmbeddings = coverage.total > 0 && coverage.withSet < coverage.total;
  return {
    disabled: false,
    title: needsEmbeddings
      ? 'Enqueue jobs for chunks missing embeddings for the active set'
      : 'No pending chunks detected – you can still enqueue a backfill to double-check.',
  };
}
