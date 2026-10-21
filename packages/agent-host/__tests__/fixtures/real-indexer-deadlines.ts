/**
 * Close-ladder deadlines for a real forked indexer that runs the agent-host state projection.
 * Its startup and requests have no deadline (lifecycle R2): the projection cold-imports
 * Mastra's Memory, so a slow startup is waited for, never retired.
 */
export const REAL_INDEXER_DEADLINES = {
  closeMs: 5000,
  exitMs: 5000,
} as const;
