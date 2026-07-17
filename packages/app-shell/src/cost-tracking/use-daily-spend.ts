import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db';
import { useMemo } from 'react';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';
import { resolveAssistantMemoryResourceId } from '../assistant-memory-resource';
import {
  DAILY_SPEND_AGGREGATION_SQL,
  type DailySpendSummary,
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
export function useDailySpend(resourceIdOverride?: string | null): DailySpendState {
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

  const mapped = useMemo<MappedSpend>(() => {
    if (!available || liveQuery.loading) {
      return { error: null, spend: null };
    }
    try {
      const rows = liveQuery.rows.map(mapDailySpendUsageRow);
      return { error: null, spend: resolveDailySpendSummary(rows, resolveModelPricing) };
    } catch (error: unknown) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
        spend: null,
      };
    }
  }, [available, liveQuery.loading, liveQuery.rows]);

  return {
    available,
    error: liveQuery.error ?? mapped.error,
    loading: liveQuery.loading,
    refresh: liveQuery.refresh,
    spend: mapped.spend,
  };
}
