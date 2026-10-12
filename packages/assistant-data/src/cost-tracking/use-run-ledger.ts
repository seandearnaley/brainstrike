import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';
import {
  mapRunLedgerRow,
  RUN_LEDGER_AGGREGATION_SQL,
  type RunLedgerRow,
} from '../assistant-memory-repository';
import { resolveAssistantMemoryResourceId } from '../assistant-memory-resource';

/** Newest-first run rows shown by the Task Ledger panel. */
export const TASK_LEDGER_RUN_LIMIT = 50;

/**
 * Reactive Task Ledger runs for the workspace, mirroring `useCrossRootCost`:
 * `available` gates on the durable-usage CAPABILITY (the desktop assistant
 * backend that writes the run tables), NOT the raw PGlite handle — web also
 * has a PGlite handle but never persists runs, so the panel must render an
 * honest session-only state there instead of a durable-but-empty table.
 */
export interface RunLedgerState {
  /** Whether durable run history is recorded here (desktop assistant backend). */
  readonly available: boolean;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly rows: readonly RunLedgerRow[];
}

interface MappedRows {
  readonly error: Error | null;
  readonly rows: readonly RunLedgerRow[];
}

/**
 * Map raw live-query rows through the repo's STRICT parser. A malformed
 * aggregate THROWS in mapRunLedgerRow exactly as on the repo path; we catch it
 * here and surface it as an error so the panel reads "couldn't load", never a
 * fabricated $0 / 0 tokens (no silent fallbacks).
 */
function mapLiveRows(rawRows: readonly Record<string, unknown>[]): MappedRows {
  try {
    return { error: null, rows: rawRows.map(mapRunLedgerRow) };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)), rows: [] };
  }
}

/**
 * Reactive run-ledger rows for the workspace. The query string + row parser
 * are shared with the validated repo method (RUN_LEDGER_AGGREGATION_SQL +
 * mapRunLedgerRow) so the aggregation and the strict no-fabrication contract
 * can never drift between the two paths — the exact reactive consumer that SQL
 * constant was exported for.
 */
const NO_HOST_RUNS: readonly RunLedgerRow[] = [];

/** `hostRuns`: agent-host threads' committed runs, listed beside the run tables' rows. */
export function useRunLedger(
  resourceIdOverride?: string | null,
  hostRuns: readonly RunLedgerRow[] = NO_HOST_RUNS
): RunLedgerState {
  const database = usePGliteDatabase();
  const available = database !== null && hasDurableAssistantUsageCapability();
  const resourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  const params = useMemo(() => [resourceId, TASK_LEDGER_RUN_LIMIT], [resourceId]);

  const liveQuery = usePGliteLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('task-ledger-runs', resourceId, TASK_LEDGER_RUN_LIMIT),
    enabled: available,
    params,
    query: RUN_LEDGER_AGGREGATION_SQL,
  });

  const mapped = useMemo<MappedRows>(() => {
    const history = mapLiveRows(liveQuery.rows);
    if (history.error || hostRuns.length === 0) {
      return history;
    }
    // Newest first, the same limit as the SQL: the panel's latest runs.
    const rows = [...history.rows, ...hostRuns]
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .slice(0, TASK_LEDGER_RUN_LIMIT);
    return { error: null, rows };
  }, [hostRuns, liveQuery.rows]);

  return {
    available,
    error: liveQuery.error ?? mapped.error,
    loading: liveQuery.loading,
    refresh: liveQuery.refresh,
    rows: mapped.rows,
  };
}
