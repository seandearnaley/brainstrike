/**
 * Utility functions for backfill button disabled state logic
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
