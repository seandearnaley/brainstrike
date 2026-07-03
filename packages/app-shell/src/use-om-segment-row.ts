/**
 * Runtime-aware read for the active thread's / workspace's observational-memory
 * (OM) row.
 *
 * Drives the OM informational stats in the context meter. PGlite stays reactive
 * via `useBrainstrikeLiveQuery`; Turso uses a strict snapshot query because the
 * desktop DB host deliberately does not expose live queries for Turso. Both read
 * RAW @mastra/memory columns off `mastra_observational_memory` — the exact
 * column set is locked by the projection drift guard in
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
 * never issues a database query — the meter renders chat-only instead. Gate on
 * `hasDurableAssistantUsageCapability()`, NOT raw database presence.
 *
 * Staleness (the bots flagged this on 5.3): `clearOnDisable: true` drops the
 * previous rows the moment the query is disabled (e.g. the last thread is closed)
 * so the meter never renders a PRIOR thread's OM row under no/another thread.
 */

import type { RuntimeAssistantMemoryScope } from '@brainstrike/assistant-contract/memory-settings';
import {
  makeLiveQueryKey,
  useAssistantMemoryDbClient,
  useBrainstrikeLiveQuery,
} from '@brainstrike/db';
import { useCallback, useEffect, useState } from 'react';
import { useAssistantMemoryInvalidationToken } from './assistant-memory-invalidation';

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

const SQLITE_OM_ROW_QUERY = `
  SELECT "observationTokenCount", "totalTokensObserved"
  FROM mastra_observational_memory
  WHERE "lookupKey" = ?
  ORDER BY "generationCount" DESC, "createdAt" DESC
  LIMIT 1
`;

interface ObservationalMemoryRowQueryResult {
  observationTokenCount: number | string;
  totalTokensObserved: number | string;
}

interface ObservationalMemorySnapshotState {
  readonly error: Error | null;
  readonly loading: boolean;
  readonly row: ObservationalMemoryRowQueryResult | null;
}

const EMPTY_SNAPSHOT_STATE: ObservationalMemorySnapshotState = {
  error: null,
  loading: false,
  row: null,
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
  const assistantMemoryDb = useAssistantMemoryDbClient();
  const database = assistantMemoryDb?.db ?? null;
  const runtimeEngine = assistantMemoryDb?.runtimeEngine ?? null;
  const lookupKey = buildObservationalMemoryLookupKey({
    scope: input.scope,
    threadId: input.threadId,
    resourceId: input.resourceId,
  });
  const enabled = input.hasDurableCapability && lookupKey !== null;
  const pgliteLiveEnabled = enabled && runtimeEngine === 'pglite';
  const tursoSnapshotEnabled = enabled && runtimeEngine === 'turso';
  const tursoInvalidationToken = useAssistantMemoryInvalidationToken(
    useCallback(
      (detail) =>
        detail.kind === 'all' ||
        (detail.kind === 'observational-memory' && detail.lookupKey === lookupKey),
      [lookupKey]
    )
  );
  const [tursoSnapshot, setTursoSnapshot] =
    useState<ObservationalMemorySnapshotState>(EMPTY_SNAPSHOT_STATE);

  const result = useBrainstrikeLiveQuery<ObservationalMemoryRowQueryResult>({
    cacheKey: makeLiveQueryKey('om-row', lookupKey ?? ''),
    query: OM_ROW_QUERY,
    params: [lookupKey ?? ''],
    enabled: pgliteLiveEnabled,
    // Drop stale rows the instant the query is disabled (thread closed / scope id
    // missing) so a prior thread's OM never leaks into another / no thread.
    clearOnDisable: true,
  });

  useEffect(() => {
    if (!(tursoSnapshotEnabled && database && lookupKey)) {
      setTursoSnapshot(EMPTY_SNAPSHOT_STATE);
      return;
    }

    let cancelled = false;
    setTursoSnapshot({ error: null, loading: true, row: null });
    database
      .query<ObservationalMemoryRowQueryResult>(SQLITE_OM_ROW_QUERY, [lookupKey])
      .then((queryResult) => {
        if (cancelled) {
          return;
        }
        setTursoSnapshot({
          error: null,
          loading: false,
          row: queryResult.rows[0] ?? null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setTursoSnapshot({ error: toError(error), loading: false, row: null });
      });

    return () => {
      cancelled = true;
    };
  }, [database, lookupKey, tursoInvalidationToken, tursoSnapshotEnabled]);

  if (tursoSnapshotEnabled) {
    return tursoSnapshot;
  }

  if (enabled && !assistantMemoryDb) {
    return { error: null, loading: true, row: null };
  }

  return {
    // Belt-and-suspenders with clearOnDisable: never surface a row from a
    // disabled query even if the live layer has not cleared yet.
    row: pgliteLiveEnabled ? (result.rows[0] ?? null) : null,
    loading: pgliteLiveEnabled && result.loading,
    error: result.error,
  };
}
