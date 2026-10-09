import {
  CROSS_ROOT_USAGE_AGGREGATION_SQL,
  type CrossRootUsageRow,
  hasDurableAssistantUsageCapability,
  mapCrossRootUsageRow,
  resolveAssistantMemoryResourceId,
} from '@brainstrike/assistant-data';
import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';

/**
 * Per-(root, provider, model) usage subtotal joined with the root's display
 * name (CrossRootUsageRow carries `rootDisplayName`, null for the unattributed
 * bucket or a legacy path-remapped join miss). NULL root_id is the
 * unattributed bucket.
 */
export type CrossRootUsageQueryRow = CrossRootUsageRow;

/**
 * Cross-root durable usage for the workspace, reactive via a PGlite live query.
 *
 * `available` reflects the durable-usage CAPABILITY (the desktop assistant
 * backend that actually writes the rows), NOT the raw PGlite handle: brainstrike
 * is local-first, so WEB also runs under a PGlite `DbProvider`, but web
 * assistant usage is session-only (in-renderer LocalRuntimeChat) and is never
 * persisted via `recordRunUsage`. On web `available` is false → the panel
 * renders an honest session-only state, NOT zeros, and no query is issued
 * against the (web-empty) usage table.
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

/**
 * Map raw live-query rows through the repo's STRICT parser. A malformed row
 * (non-finite/negative aggregate, non-string provider/model) THROWS in
 * mapCrossRootUsageRow exactly as it does on the repo path; we catch it here and
 * surface it as an error so the panel reads "couldn't load cost", never a
 * fabricated $0 / 0 tokens (no silent fallbacks).
 */
function mapLiveRows(rawRows: readonly Record<string, unknown>[]): MappedRows {
  try {
    return { error: null, rows: rawRows.map(mapCrossRootUsageRow) };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)), rows: [] };
  }
}

/**
 * Reactive cross-root usage rows for the workspace. Subscribes to a PGlite live
 * query on mount and auto-unsubscribes on unmount (the underlying hook owns the
 * lifecycle). When durable usage is unavailable (web), the query is disabled and
 * `available` is false.
 *
 * The query string + row parser are shared with the validated repo method
 * (CROSS_ROOT_USAGE_AGGREGATION_SQL + mapCrossRootUsageRow) so the aggregation
 * and the strict no-fabrication contract can never drift between the two paths.
 */
const NO_HOST_ROOT_USAGE: readonly CrossRootUsageRow[] = [];

/** `hostRootUsage`: agent-host threads' committed provider calls per root, listed beside. */
export function useCrossRootCost(
  resourceIdOverride?: string | null,
  hostRootUsage: readonly CrossRootUsageRow[] = NO_HOST_ROOT_USAGE
): CrossRootCostState {
  const database = usePGliteDatabase();
  // Gate on the SAME capability that gates the durable WRITE (the desktop
  // assistant backend), not the raw PGlite handle — web has a handle but never
  // writes these rows. Requiring the handle too keeps the query strictly off
  // until PGlite is actually ready.
  const available = database !== null && hasDurableAssistantUsageCapability();
  const resourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  const params = useMemo(() => [resourceId], [resourceId]);

  const liveQuery = usePGliteLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('cross-root-usage', resourceId),
    enabled: available,
    params,
    query: CROSS_ROOT_USAGE_AGGREGATION_SQL,
  });

  const mapped = useMemo<MappedRows>(() => {
    const history = mapLiveRows(liveQuery.rows);
    // A malformed history row stays an error: host rows never stand in for it.
    return history.error || hostRootUsage.length === 0
      ? history
      : { error: null, rows: [...history.rows, ...hostRootUsage] };
  }, [hostRootUsage, liveQuery.rows]);

  return {
    available,
    error: liveQuery.error ?? mapped.error,
    loading: liveQuery.loading,
    rows: mapped.rows,
  };
}
