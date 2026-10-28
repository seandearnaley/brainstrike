import type { RunLedgerRow } from '@brainstrike/assistant-data';

/**
 * Task Ledger analytics: the totals, the daily trend and the per-model
 * comparison, folded from the agent host's committed runs. Pure; no state, no
 * writes. The host records no provider-billed cost, so every cost here is the
 * ledger's list-price estimate, summed from calls priced one by one.
 */

/** Tokens and estimated cost over a set of runs. */
export interface LedgerUsageTotals {
  /** Prompt-cache read share of `inputTokens`. */
  readonly cacheReadTokens: number;
  /** Prompt-cache write share of `inputTokens`. */
  readonly cacheWriteTokens: number;
  /** The priced runs' cost; runs counted in `unpricedRunCount` are left out. */
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runCount: number;
  /** Runs with a call no list price covers: never counted as $0. */
  readonly unpricedRunCount: number;
}

export interface LedgerTrendPoint extends LedgerUsageTotals {
  /** The user's local calendar day, `YYYY-MM-DD`: the point's key and sort order. */
  readonly day: string;
  /** The same local day as a short label, e.g. "Oct 12". */
  readonly label: string;
}

export interface LedgerModelComparisonRow extends LedgerUsageTotals {
  /** Mean wall-clock of COMPLETED runs; null when none completed. */
  readonly avgDurationMs: number | null;
  readonly cancelledRunCount: number;
  readonly completedRunCount: number;
  readonly failedRunCount: number;
  readonly labeledFailedCount: number;
  readonly labeledMixedCount: number;
  readonly labeledSucceededCount: number;
  readonly model: string;
  readonly provider: string;
}

export const NO_LEDGER_USAGE: LedgerUsageTotals = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  runCount: 0,
  unpricedRunCount: 0,
};

/** One more run in a usage total. */
export function addRunUsage<T extends LedgerUsageTotals>(total: T, run: RunLedgerRow): T {
  return {
    ...total,
    cacheReadTokens: total.cacheReadTokens + run.estimatedCacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + run.estimatedCacheCreationTokens,
    costUsd: total.costUsd + (run.billedCostUsd ?? 0) + (run.estimatedCostUsd ?? 0),
    inputTokens: total.inputTokens + run.inputTokens,
    outputTokens: total.outputTokens + run.outputTokens,
    runCount: total.runCount + 1,
    unpricedRunCount: total.unpricedRunCount + (run.estimatedCostUsd === null ? 1 : 0),
  };
}

/** The usage and cost of every run. */
export function hostRunsTotals(hostRuns: readonly RunLedgerRow[]): LedgerUsageTotals {
  return hostRuns.reduce(addRunUsage, NO_LEDGER_USAGE);
}

/**
 * The daily trend: one point per calendar day in `timeZone`, the user's
 * resolved IANA zone, which the caller resolves once. A run counts on the
 * local day it started, and the point's key and label both come from that
 * one zone. Oldest first.
 */
export function hostRunsTrend(
  hostRuns: readonly RunLedgerRow[],
  timeZone: string
): LedgerTrendPoint[] {
  const keyFormat = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  });
  const labelFormat = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone,
  });
  const days = new Map<string, LedgerTrendPoint>();
  for (const run of hostRuns) {
    const parts = new Map(
      keyFormat.formatToParts(run.startedAt).map((part) => [part.type, part.value])
    );
    const day = `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
    const point = days.get(day) ?? {
      ...NO_LEDGER_USAGE,
      day,
      label: labelFormat.format(run.startedAt),
    };
    days.set(day, addRunUsage(point, run));
  }
  return [...days.values()].sort((left, right) => compareText(left.day, right.day));
}

const NO_MODEL_COMPARISON: Omit<LedgerModelComparisonRow, 'model' | 'provider'> = {
  ...NO_LEDGER_USAGE,
  avgDurationMs: null,
  cancelledRunCount: 0,
  completedRunCount: 0,
  failedRunCount: 0,
  labeledFailedCount: 0,
  labeledMixedCount: 0,
  labeledSucceededCount: 0,
};

/** The mean over completed runs with one more timed completed run. */
function averageWith(row: LedgerModelComparisonRow, durationMs: number): number {
  const timed = row.avgDurationMs === null ? 0 : row.completedRunCount;
  return Math.round(((row.avgDurationMs ?? 0) * timed + durationMs) / (timed + 1));
}

/** One more run in a model's comparison row. */
function addRun(row: LedgerModelComparisonRow, run: RunLedgerRow): LedgerModelComparisonRow {
  const completed = run.status === 'completed';
  return {
    ...addRunUsage(row, run),
    avgDurationMs:
      completed && run.durationMs !== null ? averageWith(row, run.durationMs) : row.avgDurationMs,
    cancelledRunCount: row.cancelledRunCount + (run.status === 'cancelled' ? 1 : 0),
    completedRunCount: row.completedRunCount + (completed ? 1 : 0),
    failedRunCount: row.failedRunCount + (run.status === 'failed' ? 1 : 0),
    labeledFailedCount: row.labeledFailedCount + (run.outcomeVerdict === 'failed' ? 1 : 0),
    labeledMixedCount: row.labeledMixedCount + (run.outcomeVerdict === 'mixed' ? 1 : 0),
    labeledSucceededCount: row.labeledSucceededCount + (run.outcomeVerdict === 'succeeded' ? 1 : 0),
  };
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** The per-model comparison of the host's runs, in provider/model order. */
export function hostRunsModelComparison(
  hostRuns: readonly RunLedgerRow[]
): LedgerModelComparisonRow[] {
  const key = (provider: string, model: string): string => JSON.stringify([provider, model]);
  const rows = new Map<string, LedgerModelComparisonRow>();
  for (const run of hostRuns) {
    const id = key(run.provider, run.model);
    const row = rows.get(id) ?? {
      ...NO_MODEL_COMPARISON,
      model: run.model,
      provider: run.provider,
    };
    rows.set(id, addRun(row, run));
  }
  // The costliest model first: the comparison answers "where does the money go".
  return [...rows.values()].sort(
    (left, right) =>
      right.costUsd - left.costUsd ||
      compareText(left.provider, right.provider) ||
      compareText(left.model, right.model)
  );
}
