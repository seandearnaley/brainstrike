import { buildTokenUsageCounts, computeCost } from '@brainstrike/tokenization';
import type { ModelPricingResolver } from '../assistant-cross-root-cost';

/**
 * Rolling last-24h spend aggregation for the budget guardrail (see
 * docs/agents/assistant-persistence.md § "Memory and accounting" → Budget guardrails).
 *
 * `$1` = resourceId. The window is `created_at >= NOW() - INTERVAL '24 hours'`
 * — a rolling, deliberately timezone-free window (UI copy must say "last
 * 24h", never "today"). Groups per (provider, model) so the unreported
 * remainder stays priceable per model: exact provider-reported cost is SUMmed
 * as-is, and only the tokens of rows WITHOUT an exact cost are carried for
 * registry pricing (same split as CROSS_ROOT_USAGE_AGGREGATION_SQL).
 *
 * PARAM-REUSE CONSTRAINT: each bind parameter must appear EXACTLY ONCE — this
 * SQL is consumed through PGlite's live extension, whose internal format()
 * rewrite fails with "too few arguments for format()" when a parameter is
 * repeated (same constraint pinned on RUN_LEDGER_AGGREGATION_SQL).
 */
export const DAILY_SPEND_AGGREGATION_SQL = `
  SELECT
    u.provider AS provider,
    u.model AS model,
    SUM(u.billed_cost_usd) AS "billedCostUsd",
    SUM(CASE WHEN u.billed_cost_usd IS NULL THEN u.input_tokens ELSE 0 END)::bigint
      AS "unreportedInputTokens",
    SUM(CASE WHEN u.billed_cost_usd IS NULL THEN u.output_tokens ELSE 0 END)::bigint
      AS "unreportedOutputTokens",
    SUM(CASE WHEN u.billed_cost_usd IS NULL THEN COALESCE(u.cache_read_input_tokens, 0) ELSE 0 END)::bigint
      AS "unreportedCacheReadTokens",
    SUM(CASE WHEN u.billed_cost_usd IS NULL THEN COALESCE(u.cache_creation_input_tokens, 0) ELSE 0 END)::bigint
      AS "unreportedCacheCreationTokens"
  FROM brainstrike_assistant_run_usage u
  WHERE u.resource_id = $1
    AND u.created_at >= NOW() - INTERVAL '24 hours'
  GROUP BY u.provider, u.model
  ORDER BY u.provider ASC, u.model ASC
`;

/**
 * One (provider, model) group inside the last-24h window. `billedCostUsd` is
 * the exact provider-reported subtotal, absent (never a fabricated 0) when no
 * row in the group carried one; the unreported token counts cover ONLY rows
 * without an exact cost, so pricing them never double-counts.
 */
export interface DailySpendUsageRow {
  readonly billedCostUsd?: number;
  readonly model: string;
  readonly provider: string;
  /** Anthropic cache-write share of `unreportedInputTokens` (0 elsewhere). */
  readonly unreportedCacheCreationTokens?: number;
  /** Anthropic cache-read share of `unreportedInputTokens` (0 elsewhere). */
  readonly unreportedCacheReadTokens?: number;
  readonly unreportedInputTokens: number;
  readonly unreportedOutputTokens: number;
}

/**
 * Derived last-24h spend. `totalUsd = exactUsd + estimatedUsd`; tokens from
 * models WITHOUT a registry list price are EXCLUDED from the total and the
 * models are named in `unpricedModels` (as `provider::model`) so the UI can
 * render an explicit "+N unpriced" marker — never a fabricated price.
 */
export interface DailySpendSummary {
  readonly estimatedUsd: number;
  readonly exactUsd: number;
  readonly totalUsd: number;
  readonly unpricedModels: readonly string[];
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid daily spend aggregate: ${fieldName} is not a string.`);
  }
  return value;
}

/** Coerce a SUM()::bigint aggregate (PGlite returns a string) strictly. */
function requireNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!(Number.isFinite(parsed) && Number.isInteger(parsed)) || parsed < 0) {
    throw new Error(`Invalid daily spend aggregate: ${fieldName} is not a non-negative integer.`);
  }
  return parsed;
}

function optionalNonNegativeFiniteNumber(value: unknown, fieldName: string): number | undefined {
  if (value === null || value === undefined) {
    return;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid daily spend aggregate: ${fieldName} is not a non-negative number.`);
  }
  return parsed;
}

/**
 * Strict parser for one DAILY_SPEND_AGGREGATION_SQL row — same no-silent-
 * fallbacks contract as mapCrossRootUsageRow: a malformed aggregate THROWS
 * rather than fabricating $0/0 tokens, and callers surface a visible error.
 */
export function mapDailySpendUsageRow(row: Record<string, unknown>): DailySpendUsageRow {
  const billedCostUsd = optionalNonNegativeFiniteNumber(row['billedCostUsd'], 'billedCostUsd');
  return {
    ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
    model: requireString(row['model'], 'model'),
    provider: requireString(row['provider'], 'provider'),
    unreportedCacheCreationTokens: requireNonNegativeInteger(
      row['unreportedCacheCreationTokens'] ?? 0,
      'unreportedCacheCreationTokens'
    ),
    unreportedCacheReadTokens: requireNonNegativeInteger(
      row['unreportedCacheReadTokens'] ?? 0,
      'unreportedCacheReadTokens'
    ),
    unreportedInputTokens: requireNonNegativeInteger(
      row['unreportedInputTokens'],
      'unreportedInputTokens'
    ),
    unreportedOutputTokens: requireNonNegativeInteger(
      row['unreportedOutputTokens'],
      'unreportedOutputTokens'
    ),
  };
}

/**
 * Price the last-24h window: exact provider-reported cost as-is, the
 * unreported remainder through the shared registry resolver, and unpriceable
 * models EXCLUDED from the total but named explicitly (honest-cost contract —
 * the guardrail must never gate, or decline to gate, on a fabricated number).
 */
export function resolveDailySpendSummary(
  rows: readonly DailySpendUsageRow[],
  resolvePricing: ModelPricingResolver
): DailySpendSummary {
  let exactUsd = 0;
  let estimatedUsd = 0;
  const unpricedModels: string[] = [];
  for (const row of rows) {
    if (row.billedCostUsd !== undefined) {
      exactUsd += row.billedCostUsd;
    }
    if (row.unreportedInputTokens + row.unreportedOutputTokens === 0) {
      continue;
    }
    const estimate = computeCost(
      buildTokenUsageCounts(
        row.unreportedInputTokens,
        row.unreportedOutputTokens,
        row.unreportedCacheReadTokens,
        row.unreportedCacheCreationTokens
      ),
      resolvePricing(row.provider, row.model)
    );
    if (estimate.available) {
      estimatedUsd += estimate.usdAmount;
    } else {
      unpricedModels.push(`${row.provider}::${row.model}`);
    }
  }
  return {
    estimatedUsd,
    exactUsd,
    totalUsd: exactUsd + estimatedUsd,
    unpricedModels,
  };
}

/** One provider call an agent-host thread committed, as the spend views count it. */
export interface HostUsageRecord {
  /** The committed row time (ms since epoch). */
  readonly at: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
}

const DAILY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The host's share of the rolling last-24h window, in the SQL aggregate's
 * shape: one row per (provider, model). The host records no provider-billed
 * cost, so every token is unreported and priced through the registry.
 */
export function hostDailySpendRows(
  records: readonly HostUsageRecord[],
  nowMs: number
): DailySpendUsageRow[] {
  const groups = new Map<string, DailySpendUsageRow>();
  for (const record of records) {
    if (record.at < nowMs - DAILY_SPEND_WINDOW_MS) {
      continue;
    }
    const key = `${record.provider}::${record.model}`;
    const row = groups.get(key);
    groups.set(key, {
      model: record.model,
      provider: record.provider,
      unreportedCacheCreationTokens:
        (row?.unreportedCacheCreationTokens ?? 0) + record.cacheWriteTokens,
      unreportedCacheReadTokens: (row?.unreportedCacheReadTokens ?? 0) + record.cacheReadTokens,
      unreportedInputTokens: (row?.unreportedInputTokens ?? 0) + record.inputTokens,
      unreportedOutputTokens: (row?.unreportedOutputTokens ?? 0) + record.outputTokens,
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)
  );
}
