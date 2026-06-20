/**
 * Live subscription to the active thread's / workspace's observational-memory
 * (OM) row.
 *
 * Drives the OM informational stats in the context meter. Reactive via
 * `usePGliteLiveQuery` (auto subscribe/unsubscribe on unmount). Reads RAW
 * @mastra/memory columns off `mastra_observational_memory` — the exact column
 * set is locked by the projection drift guard in
 * packages/db/__tests__/mastra-om-schema-projection.test.ts.
 *
 * Lookup key (mirrors the store's `observationalMemoryKey` + the library's
 * `getStorageIds`): thread-scoped OM rows are keyed `thread:{threadId}`,
 * resource/Workspace-scoped rows are keyed `resource:{resourceId}`. The scope is
 * the OM scope preference; using the wrong key shows an empty meter even though
 * observations are persisted (workspace-scope bug fixed here).
 *
 * Capability split (the bots flagged this on 5.2): the query is DISABLED on web
 * (no durable assistant usage capability) and when no key can be built, so web
 * never issues a PGlite query — the meter renders chat-only instead. Gate on
 * `hasDurableAssistantUsageCapability()`, NOT raw PGlite presence.
 *
 * Staleness (the bots flagged this on 5.3): `clearOnDisable: true` drops the
 * previous rows the moment the query is disabled (e.g. the last thread is closed)
 * so the meter never renders a PRIOR thread's OM row under no/another thread.
 */

import type { RuntimeAssistantMemoryScope } from '@brainstrike/assistant-contract/memory-settings';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';

/**
 * Build the OM lookup key the store writes under. Mirrors the memory store's
 * `observationalMemoryKey(threadId, resourceId)` and the @mastra/memory
 * `getStorageIds` scope mapping EXACTLY: resource scope → `resource:{resourceId}`
 * (threadId is null in the store), thread scope → `thread:{threadId}`. Returns
 * null when the required id for the scope is absent (no query is issued).
 */
export function buildObservationalMemoryLookupKey(input: {
  scope: RuntimeAssistantMemoryScope;
  threadId: string | undefined;
  resourceId: string | undefined;
}): string | null {
  if (input.scope === 'resource') {
    return input.resourceId ? `resource:${input.resourceId}` : null;
  }
  return input.threadId ? `thread:${input.threadId}` : null;
}

/**
 * Select the LATEST observation generation for a lookup key, mirroring the memory
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
  /** Memory resource id — the key id for Workspace (resource) scope. */
  readonly resourceId: string | undefined;
  /** OM scope preference ('thread' or 'resource'/Workspace) — selects the key shape. */
  readonly scope: RuntimeAssistantMemoryScope;
  /** Active memory thread id (selectedMemoryThreadId), or undefined when none. */
  readonly threadId: string | undefined;
}

export interface UseObservationalMemoryRowResult {
  readonly error: Error | null;
  readonly loading: boolean;
  /** Raw latest-generation OM row, or null when none / disabled. */
  readonly row: ObservationalMemoryRowQueryResult | null;
}

export function useObservationalMemoryRow(
  input: UseObservationalMemoryRowInput
): UseObservationalMemoryRowResult {
  const lookupKey = buildObservationalMemoryLookupKey({
    scope: input.scope,
    threadId: input.threadId,
    resourceId: input.resourceId,
  });
  const enabled = input.hasDurableCapability && lookupKey !== null;

  const result = usePGliteLiveQuery<ObservationalMemoryRowQueryResult>({
    cacheKey: makeLiveQueryKey('om-row', lookupKey ?? ''),
    query: OM_ROW_QUERY,
    params: [lookupKey ?? ''],
    enabled,
    // Drop stale rows the instant the query is disabled (thread closed / scope id
    // missing) so a prior thread's OM never leaks into another / no thread.
    clearOnDisable: true,
  });

  return {
    // Belt-and-suspenders with clearOnDisable: never surface a row from a
    // disabled query even if the live layer has not cleared yet.
    row: enabled ? (result.rows[0] ?? null) : null,
    loading: enabled && result.loading,
    error: result.error,
  };
}
