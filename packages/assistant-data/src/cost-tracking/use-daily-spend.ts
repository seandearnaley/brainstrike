import { useCallback, useEffect, useMemo, useState } from 'react';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';
import {
  type DailySpendSummary,
  type HostUsageRecord,
  hostDailySpendRows,
  resolveDailySpendSummary,
} from './daily-spend';
import { resolveModelPricing } from './model-pricing';

/** Rolling last-24h spend derived from the agent host’s committed provider calls. */
export interface DailySpendState {
  /** Whether durable last-24h spend is recorded here (desktop assistant backend). */
  readonly available: boolean;
  readonly error: Error | null;
  readonly refresh: () => Promise<void>;
  readonly spend: DailySpendSummary | null;
}

/** Clock-tick re-evaluation cadence for the rolling 24h window (see below). */
export const DAILY_SPEND_WINDOW_REFRESH_MS = 5 * 60 * 1000;

interface MappedSpend {
  readonly error: Error | null;
  readonly spend: DailySpendSummary | null;
}

const NO_HOST_USAGE: readonly HostUsageRecord[] = [];

export function useDailySpend(
  hostUsage: readonly HostUsageRecord[] = NO_HOST_USAGE
): DailySpendState {
  const available = hasDurableAssistantUsageCapability();
  const [windowEndMs, setWindowEndMs] = useState(() => Date.now());
  const refresh = useCallback(async (): Promise<void> => setWindowEndMs(Date.now()), []);
  useEffect(() => {
    if (!available) {
      return;
    }
    const interval = setInterval(() => {
      void refresh();
    }, DAILY_SPEND_WINDOW_REFRESH_MS);
    return () => clearInterval(interval);
  }, [available, refresh]);

  const mapped = useMemo<MappedSpend>(() => {
    if (!available) {
      return { error: null, spend: null };
    }
    try {
      const rows = [
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
  }, [available, hostUsage, windowEndMs]);

  return {
    available,
    error: mapped.error,
    refresh,
    spend: mapped.spend,
  };
}
