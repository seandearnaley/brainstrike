import { usePGliteDatabase } from '@brainstrike/db';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';
import { resolveAssistantMemoryResourceId } from '../assistant-memory-resource';
import {
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

export function useLedgerAnalytics(resourceIdOverride?: string | null): LedgerAnalyticsState {
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

  return { available, ...data, refresh };
}
