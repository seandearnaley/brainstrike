import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useEffect, useMemo, useState } from 'react';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';
import { resolveAssistantMemoryResourceId } from '../assistant-memory-resource';
import {
  DAILY_SPEND_AGGREGATION_SQL,
  type DailySpendSummary,
  type HostUsageRecord,
  hostDailySpendRows,
  mapDailySpendUsageRow,
  resolveDailySpendSummary,
} from './daily-spend';
import { resolveModelPricing } from './model-pricing';

/**
 * Reactive rolling last-24h spend for the workspace, feeding the composer's
 * budget guardrail. Mirrors `useCrossRootCost`:
 *
 * - `available` gates on the durable-usage CAPABILITY (the desktop assistant
 *   backend that writes run_usage), NOT the raw PGlite handle — web has a
 *   handle but never persists usage, so the guardrail simply does not exist
 *   there (honest absence, not a $0 burn-down).
 * - `spend` is null until the first live-query result lands: the gate must
 *   never issue a verdict (open OR closed) from a not-yet-loaded window.
 * - A malformed aggregate surfaces as `error` with `spend` null — never a
 *   fabricated $0 (no silent fallbacks).
 */
export interface DailySpendState {
  /** Whether durable last-24h spend is recorded here (desktop assistant backend). */
  readonly available: boolean;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly spend: DailySpendSummary | null;
}

/** Clock-tick re-evaluation cadence for the rolling 24h window (see below). */
export const DAILY_SPEND_WINDOW_REFRESH_MS = 5 * 60 * 1000;

interface MappedSpend {
  readonly error: Error | null;
  readonly spend: DailySpendSummary | null;
}

/**
 * Reactive last-24h spend summary. The SQL + strict row parser + pricing split
 * live in `daily-spend.ts` (pure, unit-tested); the shared registry resolver
 * (`resolveModelPricing`) prices the unreported remainder exactly like the
 * cost panels, so the guardrail's numbers can never drift from the ledger's.
 */
const NO_HOST_USAGE: readonly HostUsageRecord[] = [];

/** `hostUsage`: agent-host threads' committed provider calls, counted beside run_usage. */
export function useDailySpend(
  resourceIdOverride?: string | null,
  hostUsage: readonly HostUsageRecord[] = NO_HOST_USAGE
): DailySpendState {
  const database = usePGliteDatabase();
  const available = database !== null && hasDurableAssistantUsageCapability();
  const resourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  const params = useMemo(() => [resourceId], [resourceId]);

  const liveQuery = usePGliteLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('daily-spend', resourceId),
    enabled: available,
    params,
    query: DAILY_SPEND_AGGREGATION_SQL,
  });

  // The rolling NOW() - 24h window ages out silently: live queries only
  // re-run on table changes, so an over-cap verdict would otherwise stay
  // stale until the next write (review #1714). A bounded 5-minute clock tick
  // re-evaluates the window; the gate can therefore reopen at most 5 minutes
  // after the oldest usage row leaves the window.
  // The same tick re-evaluates the host's share of the window.
  const refresh = liveQuery.refresh;
  const [windowEndMs, setWindowEndMs] = useState(() => Date.now());
  useEffect(() => {
    if (!available) {
      return;
    }
    const interval = setInterval(() => {
      setWindowEndMs(Date.now());
      void refresh();
    }, DAILY_SPEND_WINDOW_REFRESH_MS);
    return () => clearInterval(interval);
  }, [available, refresh]);

  const mapped = useMemo<MappedSpend>(() => {
    if (!available || liveQuery.loading) {
      return { error: null, spend: null };
    }
    try {
      const rows = [
        ...liveQuery.rows.map(mapDailySpendUsageRow),
        // A new host call moves the window's end to now, never earlier.
        ...hostDailySpendRows(hostUsage, Math.max(windowEndMs, Date.now())),
      ];
      return { error: null, spend: resolveDailySpendSummary(rows, resolveModelPricing) };
    } catch (error: unknown) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
        spend: null,
      };
    }
  }, [available, hostUsage, liveQuery.loading, liveQuery.rows, windowEndMs]);

  return {
    available,
    error: liveQuery.error ?? mapped.error,
    loading: liveQuery.loading,
    refresh: liveQuery.refresh,
    spend: mapped.spend,
  };
}
