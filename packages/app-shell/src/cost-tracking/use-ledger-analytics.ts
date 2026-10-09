import {
  hasDurableAssistantUsageCapability,
  type RunLedgerRow,
  resolveAssistantMemoryResourceId,
} from '@brainstrike/assistant-data';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addHostRunsToModelComparison,
  addHostRunsToTrend,
  getLedgerCostTrend,
  getModelComparison,
  type LedgerModelComparisonRow,
  type LedgerTrendPoint,
} from '../run-ledger-analytics';

/**
 * Task Ledger analytics (daily cost trend + model comparison), fetched
 * renderer-direct (Path A) against the local PGlite handle — the same handle
 * the sibling cost panel reads. These aggregations are point-in-time queries
 * (no live-query variant exists for them), so the hook loads on mount and
 * exposes `refresh` for the panel's manual refresh button.
 *
 * `available` gates on the durable-usage capability exactly like
 * `useCrossRootCost`: web has a PGlite handle but never writes run tables, so
 * no query is issued there and the panel renders an honest session-only state.
 */
export interface LedgerAnalyticsState {
  /** Whether durable run analytics exist here (desktop assistant backend). */
  readonly available: boolean;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly models: readonly LedgerModelComparisonRow[];
  readonly refresh: () => Promise<void>;
  readonly trend: readonly LedgerTrendPoint[];
}

interface AnalyticsData {
  readonly error: Error | null;
  readonly loading: boolean;
  readonly models: readonly LedgerModelComparisonRow[];
  readonly trend: readonly LedgerTrendPoint[];
}

const INITIAL_DATA: AnalyticsData = { error: null, loading: false, models: [], trend: [] };
const NO_HOST_RUNS: readonly RunLedgerRow[] = [];

/** `hostRuns`: agent-host threads' committed runs, counted beside the run tables' rows. */
export function useLedgerAnalytics(
  resourceIdOverride?: string | null,
  hostRuns: readonly RunLedgerRow[] = NO_HOST_RUNS
): LedgerAnalyticsState {
  const database = usePGliteDatabase();
  const available = database !== null && hasDurableAssistantUsageCapability();
  const resourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  const [data, setData] = useState<AnalyticsData>(INITIAL_DATA);
  // Monotonic request id: a stale (superseded or post-unmount) response must
  // never clobber the state of a newer load.
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!(database && available)) {
      return;
    }
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setData((previous) => ({ ...previous, loading: true }));
    try {
      const [trend, models] = await Promise.all([
        getLedgerCostTrend(database, resourceId, { bucket: 'day' }),
        getModelComparison(database, resourceId),
      ]);
      if (requestIdRef.current === requestId) {
        setData({ error: null, loading: false, models, trend });
      }
    } catch (error: unknown) {
      // Strict parsers / query failures surface as a visible error state —
      // the panel must read "couldn't load", never an empty-but-fine ledger.
      if (requestIdRef.current === requestId) {
        setData({
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
          models: [],
          trend: [],
        });
      }
    }
  }, [available, database, resourceId]);

  useEffect(() => {
    void refresh();
    return () => {
      // Invalidate in-flight loads on unmount / dependency change.
      requestIdRef.current += 1;
    };
  }, [refresh]);

  // A failed history read stays an error: host runs never stand in for it.
  const combined = useMemo<AnalyticsData>(
    () =>
      data.error || hostRuns.length === 0
        ? data
        : {
            ...data,
            models: addHostRunsToModelComparison(data.models, hostRuns),
            trend: addHostRunsToTrend(data.trend, hostRuns),
          },
    [data, hostRuns]
  );

  return { available, ...combined, refresh };
}
