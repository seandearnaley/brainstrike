import type { RunLedgerRow } from '@brainstrike/assistant-data';

/**
 * Task Ledger analytics: the daily trend and the per-model comparison, folded
 * from the agent host's committed runs. Pure; no state, no writes. The host
 * records no provider-billed cost, so every token here is estimated and no
 * point or row claims an exact cost.
 */

export interface LedgerTrendPoint {
  readonly billedCostUsd?: number;
  /** The user's local calendar day, `YYYY-MM-DD`: the point's key and sort order. */
  readonly day: string;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly inputTokens: number;
  /** The same local day as a short label, e.g. "Oct 12". */
  readonly label: string;
  readonly outputTokens: number;
  readonly runCount: number;
}

export interface LedgerModelComparisonRow {
  /** Mean wall-clock of COMPLETED runs; null when none completed. */
  readonly avgDurationMs: number | null;
  readonly billedCostUsd?: number;
  readonly cancelledRunCount: number;
  readonly completedRunCount: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly failedRunCount: number;
  readonly inputTokens: number;
  readonly labeledFailedCount: number;
  readonly labeledMixedCount: number;
  readonly labeledSucceededCount: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
  readonly runCount: number;
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
    const point = days.get(day);
    days.set(day, {
      day,
      estimatedInputTokens: (point?.estimatedInputTokens ?? 0) + run.estimatedInputTokens,
      estimatedOutputTokens: (point?.estimatedOutputTokens ?? 0) + run.estimatedOutputTokens,
      inputTokens: (point?.inputTokens ?? 0) + run.inputTokens,
      label: point?.label ?? labelFormat.format(run.startedAt),
      outputTokens: (point?.outputTokens ?? 0) + run.outputTokens,
      runCount: (point?.runCount ?? 0) + 1,
    });
  }
  return [...days.values()].sort((left, right) => compareText(left.day, right.day));
}

const NO_MODEL_COMPARISON: Omit<LedgerModelComparisonRow, 'model' | 'provider'> = {
  avgDurationMs: null,
  cancelledRunCount: 0,
  completedRunCount: 0,
  estimatedInputTokens: 0,
  estimatedOutputTokens: 0,
  failedRunCount: 0,
  inputTokens: 0,
  labeledFailedCount: 0,
  labeledMixedCount: 0,
  labeledSucceededCount: 0,
  outputTokens: 0,
  runCount: 0,
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
    ...row,
    avgDurationMs:
      completed && run.durationMs !== null ? averageWith(row, run.durationMs) : row.avgDurationMs,
    cancelledRunCount: row.cancelledRunCount + (run.status === 'cancelled' ? 1 : 0),
    completedRunCount: row.completedRunCount + (completed ? 1 : 0),
    estimatedInputTokens: row.estimatedInputTokens + run.estimatedInputTokens,
    estimatedOutputTokens: row.estimatedOutputTokens + run.estimatedOutputTokens,
    failedRunCount: row.failedRunCount + (run.status === 'failed' ? 1 : 0),
    inputTokens: row.inputTokens + run.inputTokens,
    labeledFailedCount: row.labeledFailedCount + (run.outcomeVerdict === 'failed' ? 1 : 0),
    labeledMixedCount: row.labeledMixedCount + (run.outcomeVerdict === 'mixed' ? 1 : 0),
    labeledSucceededCount: row.labeledSucceededCount + (run.outcomeVerdict === 'succeeded' ? 1 : 0),
    outputTokens: row.outputTokens + run.outputTokens,
    runCount: row.runCount + 1,
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
  return [...rows.values()].sort((left, right) =>
    left.provider === right.provider
      ? compareText(left.model, right.model)
      : compareText(left.provider, right.provider)
  );
}
