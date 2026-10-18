import { getTimeoutMultiplier } from '@brainstrike/test-utils/test-timeouts';

/**
 * Deadlines for a real forked indexer that runs the agent-host state projection.
 * A test budget, not the product's (production callers allow 60_000 ms). The
 * projection cold-imports Mastra's Memory, so startup is the slow stage: a fixed
 * 5 s failed every real-indexer observation case under coverage on a hosted
 * runner 1.7x slower than usual. 10 s scaled by TEST_TIMEOUT_MULTIPLIER, as
 * BST-2147 gave the indexer's own state-observation suite.
 */
export const REAL_INDEXER_DEADLINES = {
  closeMs: 5000,
  exitMs: 5000,
  requestMs: 5000,
  startupMs: 10_000 * getTimeoutMultiplier(),
} as const;
