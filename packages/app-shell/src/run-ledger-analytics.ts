import type { DbHandle } from '@brainstrike/db';

/**
 * Task Ledger analytics: pure SQL aggregations over the run tables the
 * assistant already writes (thread_runs, run_usage, run_outcomes). Read-only
 * companions to `getRunLedger` — no new state, no writes, renderer-direct
 * (Path A). Strict parsing throughout: a malformed aggregate THROWS rather
 * than fabricating zeros (no-silent-fallbacks contract).
 *
 * Estimated-vs-exact provenance follows the same accounting RULE as
 * CROSS_ROOT_USAGE_AGGREGATION_SQL — `billedCostUsd` sums only
 * provider-reported rows and the estimated token columns cover exactly the
 * rows WITHOUT a reported cost, so a consumer can price the estimated
 * remainder per model without double counting. The result SHAPE deliberately
 * diverges from `mapCrossRootUsageRow` (review #1695): there the estimated
 * columns are emitted only when an unpriced remainder exists; here they are
 * ALWAYS present (0 when every row was provider-priced) so chart consumers
 * never branch on optional fields.
 */

export type LedgerTrendBucket = 'day' | 'hour' | 'week';

export interface LedgerTrendPoint {
  readonly billedCostUsd?: number;
  readonly bucketStart: Date;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runCount: number;
}

export interface LedgerTrendOptions {
  readonly bucket: LedgerTrendBucket;
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

// date_bin strides are fixed literals selected from this record — bucket names
// never reach SQL construction as free text.
const TREND_BUCKET_STRIDES: Record<LedgerTrendBucket, string> = {
  day: '1 day',
  hour: '1 hour',
  week: '7 days',
};

// A stable UTC origin for date_bin so bucket boundaries are deterministic
// (midnight-aligned for day/week strides, top-of-hour for hour strides).
const TREND_BUCKET_ORIGIN = "TIMESTAMPTZ '2001-01-01T00:00:00Z'";

function requireCount(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ledger aggregate ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function optionalCost(value: unknown, fieldName: string): number | undefined {
  if (value === null || value === undefined) {
    return;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ledger aggregate ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function requireBucketDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new Error(`Invalid ledger trend bucket timestamp: ${String(value)}`);
}

function nullableAverageMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ledger aggregate avgDurationMs: ${String(value)}`);
  }
  return Math.round(parsed);
}

/**
 * Cost/token totals bucketed over time (the "cost over time" chart). One row
 * per non-empty date_bin bucket of run_usage.created_at, oldest first.
 */
export async function getLedgerCostTrend(
  db: DbHandle,
  resourceId: string,
  options: LedgerTrendOptions
): Promise<readonly LedgerTrendPoint[]> {
  const stride = TREND_BUCKET_STRIDES[options.bucket];
  if (!stride) {
    throw new Error(`Unsupported trend bucket: ${String(options.bucket)}`);
  }
  const result = await db.query<Record<string, unknown>>(
    `SELECT
       date_bin(INTERVAL '${stride}', u.created_at, ${TREND_BUCKET_ORIGIN}) AS "bucketStart",
       COUNT(DISTINCT u.run_id) AS "runCount",
       SUM(u.input_tokens) AS "inputTokens",
       SUM(u.output_tokens) AS "outputTokens",
       SUM(u.billed_cost_usd) AS "billedCostUsd",
       SUM(CASE WHEN u.billed_cost_usd IS NULL THEN u.input_tokens ELSE 0 END)
         AS "estimatedInputTokens",
       SUM(CASE WHEN u.billed_cost_usd IS NULL THEN u.output_tokens ELSE 0 END)
         AS "estimatedOutputTokens"
     FROM brainstrike_assistant_run_usage u
     WHERE u.resource_id = $1
     GROUP BY 1
     ORDER BY 1 ASC`,
    [resourceId]
  );
  return result.rows.map((row) => {
    const billedCostUsd = optionalCost(row['billedCostUsd'], 'billedCostUsd');
    return {
      ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
      bucketStart: requireBucketDate(row['bucketStart']),
      estimatedInputTokens: requireCount(row['estimatedInputTokens'], 'estimatedInputTokens'),
      estimatedOutputTokens: requireCount(row['estimatedOutputTokens'], 'estimatedOutputTokens'),
      inputTokens: requireCount(row['inputTokens'], 'inputTokens'),
      outputTokens: requireCount(row['outputTokens'], 'outputTokens'),
      runCount: requireCount(row['runCount'], 'runCount'),
    };
  });
}

/**
 * Per-(provider, model) comparison: transport statuses, outcome labels, token
 * totals with estimated/exact provenance, exact billed cost, and average
 * completed-run duration. The raw material for "Sonnet succeeded on 14/15
 * rename tasks at 1/10 the cost" — ratio math belongs to the consumer, which
 * also owns pricing the estimated remainder.
 */
export async function getModelComparison(
  db: DbHandle,
  resourceId: string
): Promise<readonly LedgerModelComparisonRow[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT
       tr.provider AS provider,
       tr.model AS model,
       COUNT(*) AS "runCount",
       COUNT(*) FILTER (WHERE tr.status = 'completed') AS "completedRunCount",
       COUNT(*) FILTER (WHERE tr.status = 'failed') AS "failedRunCount",
       COUNT(*) FILTER (WHERE tr.status = 'cancelled') AS "cancelledRunCount",
       AVG(EXTRACT(EPOCH FROM (tr.completed_at - tr.started_at)) * 1000)
         FILTER (WHERE tr.status = 'completed' AND tr.completed_at IS NOT NULL)
         AS "avgDurationMs",
       COUNT(*) FILTER (WHERE o.verdict = 'succeeded') AS "labeledSucceededCount",
       COUNT(*) FILTER (WHERE o.verdict = 'failed') AS "labeledFailedCount",
       COUNT(*) FILTER (WHERE o.verdict = 'mixed') AS "labeledMixedCount",
       COALESCE(SUM(u.input_tokens), 0) AS "inputTokens",
       COALESCE(SUM(u.output_tokens), 0) AS "outputTokens",
       SUM(u.billed_cost_usd) AS "billedCostUsd",
       COALESCE(SUM(u.estimated_input_tokens), 0) AS "estimatedInputTokens",
       COALESCE(SUM(u.estimated_output_tokens), 0) AS "estimatedOutputTokens"
     FROM brainstrike_assistant_thread_runs tr
     LEFT JOIN (
       SELECT run_id,
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(billed_cost_usd) AS billed_cost_usd,
         SUM(CASE WHEN billed_cost_usd IS NULL THEN input_tokens ELSE 0 END)
           AS estimated_input_tokens,
         SUM(CASE WHEN billed_cost_usd IS NULL THEN output_tokens ELSE 0 END)
           AS estimated_output_tokens
       FROM brainstrike_assistant_run_usage
       WHERE resource_id = $1
       GROUP BY run_id
     ) u ON u.run_id = tr.id
     LEFT JOIN brainstrike_assistant_run_outcomes o ON o.run_id = tr.id
     WHERE tr.resource_id = $1
     GROUP BY tr.provider, tr.model
     ORDER BY tr.provider ASC, tr.model ASC`,
    [resourceId]
  );
  return result.rows.map((row) => {
    const billedCostUsd = optionalCost(row['billedCostUsd'], 'billedCostUsd');
    return {
      ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
      avgDurationMs: nullableAverageMs(row['avgDurationMs']),
      cancelledRunCount: requireCount(row['cancelledRunCount'], 'cancelledRunCount'),
      completedRunCount: requireCount(row['completedRunCount'], 'completedRunCount'),
      estimatedInputTokens: requireCount(row['estimatedInputTokens'], 'estimatedInputTokens'),
      estimatedOutputTokens: requireCount(row['estimatedOutputTokens'], 'estimatedOutputTokens'),
      failedRunCount: requireCount(row['failedRunCount'], 'failedRunCount'),
      inputTokens: requireCount(row['inputTokens'], 'inputTokens'),
      labeledFailedCount: requireCount(row['labeledFailedCount'], 'labeledFailedCount'),
      labeledMixedCount: requireCount(row['labeledMixedCount'], 'labeledMixedCount'),
      labeledSucceededCount: requireCount(row['labeledSucceededCount'], 'labeledSucceededCount'),
      model: typeof row['model'] === 'string' ? row['model'] : rejectString(row['model'], 'model'),
      outputTokens: requireCount(row['outputTokens'], 'outputTokens'),
      provider:
        typeof row['provider'] === 'string'
          ? row['provider']
          : rejectString(row['provider'], 'provider'),
      runCount: requireCount(row['runCount'], 'runCount'),
    };
  });
}

function rejectString(value: unknown, fieldName: string): never {
  throw new Error(`Invalid ledger aggregate ${fieldName}: ${String(value)}`);
}
