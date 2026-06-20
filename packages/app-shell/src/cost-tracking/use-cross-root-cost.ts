import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db';
import { useMemo } from 'react';
import type { CrossRootUsageRow } from '../assistant-memory-repository';
import { resolveAssistantMemoryResourceId } from '../assistant-memory-resource';

/**
 * Per-(root, provider, model) usage subtotal joined with the root's display
 * name. The live query LEFT JOINs the roots table so newly-registered roots
 * (whose client id == roots.id) resolve a name; legacy path-remapped roots
 * miss the join and surface a null name (the panel shows a short id — honest,
 * never a wrong name). NULL root_id is the unattributed bucket.
 */
export interface CrossRootUsageQueryRow extends CrossRootUsageRow {
  readonly rootDisplayName: string | null;
}

/**
 * Cross-root durable usage for the workspace, reactive via a PGlite live query.
 *
 * `available` is false on WEB (no PGlite assistant repo) — the panel renders an
 * honest "session-only" state, NOT zeros (capability-gated, no isElectron).
 */
export interface CrossRootCostState {
  /** Whether the durable cross-root store exists (desktop). */
  readonly available: boolean;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly rows: readonly CrossRootUsageQueryRow[];
}

const CROSS_ROOT_USAGE_TABLE = 'brainstrike_assistant_run_usage';

// Aggregate ALL of the workspace's durable usage by (root, provider, model),
// joining the root's display name. A GROUP BY aggregate has no stable per-row
// identity, so this MUST run in full-refresh ('query') mode, never incremental
// — mirrors the single-aggregate live queries elsewhere (e.g. queue counts).
const CROSS_ROOT_USAGE_QUERY = `
  SELECT
    u.root_id AS "rootId",
    r.display_name AS "rootDisplayName",
    u.provider AS provider,
    u.model AS model,
    SUM(u.input_tokens)::bigint AS "inputTokens",
    SUM(u.output_tokens)::bigint AS "outputTokens"
  FROM ${CROSS_ROOT_USAGE_TABLE} u
  LEFT JOIN roots r ON r.id = u.root_id
  WHERE u.resource_id = $1
  GROUP BY u.root_id, r.display_name, u.provider, u.model
  ORDER BY u.root_id ASC NULLS FIRST, u.provider ASC, u.model ASC
`;

interface RawCrossRootUsageRow {
  inputTokens: unknown;
  model: unknown;
  outputTokens: unknown;
  provider: unknown;
  rootDisplayName: unknown;
  rootId: unknown;
}

function toNonNegativeInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapRow(row: RawCrossRootUsageRow): CrossRootUsageQueryRow {
  return {
    rootId: toNullableString(row.rootId),
    rootDisplayName: toNullableString(row.rootDisplayName),
    provider: typeof row.provider === 'string' ? row.provider : '',
    model: typeof row.model === 'string' ? row.model : '',
    inputTokens: toNonNegativeInteger(row.inputTokens),
    outputTokens: toNonNegativeInteger(row.outputTokens),
  };
}

/**
 * Reactive cross-root usage rows for the workspace. Subscribes to a PGlite live
 * query on mount and auto-unsubscribes on unmount (the underlying hook owns the
 * lifecycle). On web the database handle is absent, so the query is disabled
 * and `available` is false.
 */
export function useCrossRootCost(resourceIdOverride?: string | null): CrossRootCostState {
  const database = usePGliteDatabase();
  const available = database !== null;
  const resourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  const params = useMemo(() => [resourceId], [resourceId]);

  const liveQuery = usePGliteLiveQuery<RawCrossRootUsageRow>({
    cacheKey: makeLiveQueryKey('cross-root-usage', resourceId),
    query: CROSS_ROOT_USAGE_QUERY,
    params,
    enabled: available,
  });

  const rows = useMemo(() => liveQuery.rows.map(mapRow), [liveQuery.rows]);

  return {
    available,
    error: liveQuery.error,
    loading: liveQuery.loading,
    rows,
  };
}
