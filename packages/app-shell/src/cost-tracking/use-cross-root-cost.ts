import { makeLiveQueryKey, useBrainstrikeDbClient, useBrainstrikeLiveQuery } from '@brainstrike/db';
import { useMemo } from 'react';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';
import {
  CROSS_ROOT_USAGE_AGGREGATION_SQL,
  type CrossRootUsageRow,
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
    return { rows: rawRows.map(mapCrossRootUsageRow), error: null };
  } catch (error: unknown) {
    return { rows: [], error: error instanceof Error ? error : new Error(String(error)) };
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
export function useCrossRootCost(resourceIdOverride?: string | null): CrossRootCostState {
  const database = useBrainstrikeDbClient();
  // Gate on the SAME capability that gates the durable WRITE (the desktop
  // assistant backend), not the raw PGlite handle — web has a handle but never
  // writes these rows. Requiring the handle too keeps the query strictly off
  // until PGlite is actually ready.
  const available = database !== null && hasDurableAssistantUsageCapability();
  const resourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  const params = useMemo(() => [resourceId], [resourceId]);

  const liveQuery = useBrainstrikeLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('cross-root-usage', resourceId),
    query: CROSS_ROOT_USAGE_AGGREGATION_SQL,
    params,
    enabled: available,
  });

  const mapped = useMemo<MappedRows>(() => mapLiveRows(liveQuery.rows), [liveQuery.rows]);

  return {
    available,
    error: liveQuery.error ?? mapped.error,
    loading: liveQuery.loading,
    rows: mapped.rows,
  };
}
