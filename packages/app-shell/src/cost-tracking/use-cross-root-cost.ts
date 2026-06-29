import {
  makeLiveQueryKey,
  useAssistantMemoryDbClient,
  useBrainstrikeLiveQuery,
} from '@brainstrike/db';
import { useEffect, useMemo, useState } from 'react';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';
import {
  CROSS_ROOT_USAGE_AGGREGATION_SQL,
  type CrossRootUsageRow,
  createAssistantThreadRepository,
  mapCrossRootUsageRow,
} from '../assistant-memory-repository';
import { resolveAssistantMemoryResourceId } from '../assistant-memory-resource';

/**
 * Per-(root, provider, model) usage subtotal joined with the root's display
 * name (CrossRootUsageRow carries `rootDisplayName`, null for the unattributed
 * bucket or a legacy path-remapped join miss). NULL root_id is the
 * unattributed bucket.
 */
export type CrossRootUsageQueryRow = CrossRootUsageRow;

/**
 * Cross-root durable usage for the workspace.
 *
 * `available` reflects the durable-usage CAPABILITY (the desktop assistant
 * backend that actually writes the rows), NOT a raw database handle: brainstrike
 * is local-first, so WEB can have a local DB while assistant usage remains
 * session-only (in-renderer LocalRuntimeChat) and is never persisted via
 * `recordRunUsage`. On web `available` is false → the panel renders an honest
 * session-only state, NOT zeros, and no query is issued against the usage table.
 */
export interface CrossRootCostState {
  /** Whether durable cross-root usage is recorded here (desktop assistant backend). */
  readonly available: boolean;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly rows: readonly CrossRootUsageQueryRow[];
}

interface MappedRows {
  readonly error: Error | null;
  readonly rows: readonly CrossRootUsageQueryRow[];
}

interface CrossRootCostSnapshotState {
  readonly error: Error | null;
  readonly loading: boolean;
  readonly rows: readonly CrossRootUsageQueryRow[];
}

const EMPTY_SNAPSHOT_STATE: CrossRootCostSnapshotState = {
  error: null,
  loading: false,
  rows: [],
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Map raw live-query rows through the repo's STRICT parser. A malformed row
 * (non-finite/negative aggregate, non-string provider/model) THROWS in
 * mapCrossRootUsageRow exactly as it does on the repo path; we catch it here and
 * surface it as an error so the panel reads "couldn't load cost", never a
 * fabricated $0 / 0 tokens (no silent fallbacks).
 */
function mapLiveRows(rawRows: readonly Record<string, unknown>[]): MappedRows {
  try {
    return { rows: rawRows.map(mapCrossRootUsageRow), error: null };
  } catch (error: unknown) {
    return { rows: [], error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Cross-root usage rows for the workspace. PGlite subscribes to a live query
 * (the underlying hook owns subscribe/unsubscribe); Turso uses the runtime-aware
 * assistant-thread repository snapshot because Turso live queries are not
 * exposed by the desktop DB host. When durable usage is unavailable (web), the
 * query/read is disabled and `available` is false.
 *
 * The query string + row parser are shared with the validated repo method
 * (CROSS_ROOT_USAGE_AGGREGATION_SQL + mapCrossRootUsageRow) so the aggregation
 * and the strict no-fabrication contract can never drift between the two paths.
 */
export function useCrossRootCost(resourceIdOverride?: string | null): CrossRootCostState {
  const assistantMemoryDb = useAssistantMemoryDbClient();
  const database = assistantMemoryDb?.db ?? null;
  const runtimeEngine = assistantMemoryDb?.runtimeEngine ?? null;
  // Gate on the SAME capability that gates the durable WRITE (the desktop
  // assistant backend), not the raw PGlite handle — web has a handle but never
  // writes these rows. Requiring the assistant-memory handle too keeps reads
  // strictly off until the active runtime is ready.
  const available = assistantMemoryDb !== null && hasDurableAssistantUsageCapability();
  const resourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  const params = useMemo(() => [resourceId], [resourceId]);
  const pgliteLiveEnabled = available && runtimeEngine === 'pglite';
  const tursoSnapshotEnabled = available && runtimeEngine === 'turso';
  const repository = useMemo(
    () =>
      database && runtimeEngine === 'turso'
        ? createAssistantThreadRepository(database, runtimeEngine)
        : null,
    [database, runtimeEngine]
  );
  const [tursoSnapshot, setTursoSnapshot] =
    useState<CrossRootCostSnapshotState>(EMPTY_SNAPSHOT_STATE);

  const liveQuery = useBrainstrikeLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('cross-root-usage', resourceId),
    query: CROSS_ROOT_USAGE_AGGREGATION_SQL,
    params,
    enabled: pgliteLiveEnabled,
  });

  useEffect(() => {
    if (!(tursoSnapshotEnabled && repository)) {
      setTursoSnapshot(EMPTY_SNAPSHOT_STATE);
      return;
    }

    let cancelled = false;
    setTursoSnapshot({ error: null, loading: true, rows: [] });
    repository
      .getCrossRootUsage(resourceId)
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setTursoSnapshot({ error: null, loading: false, rows });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setTursoSnapshot({ error: toError(error), loading: false, rows: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [repository, resourceId, tursoSnapshotEnabled]);

  const mapped = useMemo<MappedRows>(() => mapLiveRows(liveQuery.rows), [liveQuery.rows]);

  if (!available) {
    return {
      available: false,
      error: null,
      loading: false,
      rows: [],
    };
  }

  if (tursoSnapshotEnabled) {
    return {
      available: true,
      error: tursoSnapshot.error,
      loading: tursoSnapshot.loading,
      rows: tursoSnapshot.rows,
    };
  }

  return {
    available,
    error: liveQuery.error ?? mapped.error,
    loading: liveQuery.loading,
    rows: mapped.rows,
  };
}
