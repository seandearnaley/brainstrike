/**
 * Live subscription to the active thread's observational-memory (OM) row.
 *
 * Drives the OM segment + compaction stat in the context meter. Reactive via
 * `usePGliteLiveQuery` (auto subscribe/unsubscribe on unmount). Reads RAW
 * @mastra/memory columns off `mastra_observational_memory` — the exact column
 * set is locked by the projection drift guard in
 * packages/db/__tests__/mastra-om-schema-projection.test.ts.
 *
 * Capability split (the bots flagged this on 5.2): the query is DISABLED on web
 * (no durable assistant usage capability) and when there is no active thread, so
 * web never issues a PGlite query — the meter renders chat-only instead. Gate on
 * `hasDurableAssistantUsageCapability()`, NOT raw PGlite presence.
 */
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';

/** OM rows are keyed `thread:{threadId}` for thread scope (mastra observationalMemoryKey). */
export const OBSERVATIONAL_MEMORY_LOOKUP_KEY_PREFIX = 'thread:' as const;

/**
 * Select the LATEST observation generation for a thread, mirroring the memory
 * store's read order (`getObservationalMemory`: generationCount DESC, createdAt
 * DESC, LIMIT 1). Only the two token columns the meter needs are projected.
 */
const OM_ROW_QUERY = `
  SELECT "observationTokenCount", "totalTokensObserved"
  FROM mastra_observational_memory
  WHERE "lookupKey" = $1
  ORDER BY "generationCount" DESC, "createdAt" DESC
  LIMIT 1
`;

interface ObservationalMemoryRowQueryResult {
  observationTokenCount: number | string;
  totalTokensObserved: number | string;
}

export interface UseObservationalMemoryRowInput {
  /** Desktop-only OM persistence signal — hasDurableAssistantUsageCapability(). */
  readonly hasDurableCapability: boolean;
  /** Active memory thread id (selectedMemoryThreadId), or undefined when none. */
  readonly threadId: string | undefined;
}

export interface UseObservationalMemoryRowResult {
  readonly error: Error | null;
  readonly loading: boolean;
  /** Raw latest-generation OM row for the thread, or null when none / disabled. */
  readonly row: ObservationalMemoryRowQueryResult | null;
}

export function useObservationalMemoryRow(
  input: UseObservationalMemoryRowInput
): UseObservationalMemoryRowResult {
  const enabled = input.hasDurableCapability && typeof input.threadId === 'string';
  const lookupKey = input.threadId
    ? `${OBSERVATIONAL_MEMORY_LOOKUP_KEY_PREFIX}${input.threadId}`
    : '';

  const result = usePGliteLiveQuery<ObservationalMemoryRowQueryResult>({
    cacheKey: makeLiveQueryKey('om-row', lookupKey),
    query: OM_ROW_QUERY,
    params: [lookupKey],
    enabled,
  });

  return {
    row: result.rows[0] ?? null,
    loading: result.loading,
    error: result.error,
  };
}
