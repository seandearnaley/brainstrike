import type { RunLedgerRow } from '@brainstrike/assistant-data';
import { useMemo } from 'react';
import {
  hostRunsModelComparison,
  hostRunsTotals,
  hostRunsTrend,
  type LedgerModelComparisonRow,
  type LedgerTrendPoint,
  type LedgerUsageTotals,
} from '../run-ledger-analytics';

/** Task Ledger analytics: the totals, daily trend and model comparison of the host's runs. */
export interface LedgerAnalyticsState {
  readonly models: readonly LedgerModelComparisonRow[];
  readonly totals: LedgerUsageTotals;
  readonly trend: readonly LedgerTrendPoint[];
}

/**
 * Folds the agent host's committed runs. The trend's days are the user's: the
 * one time-zone rule is the runtime's resolved IANA zone, resolved here and
 * passed down.
 */
export function useLedgerAnalytics(hostRuns: readonly RunLedgerRow[]): LedgerAnalyticsState {
  return useMemo(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      models: hostRunsModelComparison(hostRuns),
      totals: hostRunsTotals(hostRuns),
      trend: hostRunsTrend(hostRuns, timeZone),
    };
  }, [hostRuns]);
}
