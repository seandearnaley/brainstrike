import { requireRunStatus } from './assistant-thread-rows.js';
import type {
  AssistantRunOutcomeSource,
  AssistantRunOutcomeVerdict,
  CrossRootUsageRow,
  RunLedgerRow,
} from './assistant-thread-types.js';
import {
  boundedNullableString,
  MAX_ROOT_DISPLAY_NAME_CHARS,
  normalizeDate,
  normalizeNullableDate,
  nullableString,
  optionalNonNegativeFiniteNumber,
  requireNonNegativeInteger,
  requireString,
} from './assistant-value-coercion.js';

/**
 * Single source of truth for the cross-root usage aggregation. Both the
 * validated repo method (`getCrossRootUsage`) and the reactive live-query hook
 * (`useCrossRootCost`) reference this exact string so the grouping/ordering and
 * the roots join can never silently drift between them.
 *
 * `$1` = resourceId. Groups per (root, provider, model) so cost stays priceable
 * per model. NULLS FIRST renders the "unattributed" bucket deterministically.
 * The LEFT JOIN resolves the root's display name (null for the null bucket or a
 * join miss); the `r.display_name` GROUP BY key is functionally determined by
 * `u.root_id` (the roots PK), so it does not change the grouping.
 */
export const CROSS_ROOT_USAGE_AGGREGATION_SQL = `
  SELECT
    u.root_id AS "rootId",
    -- Bound the rendered root name: an arbitrarily long display_name must not
    -- blow up the cost panel. SUBSTR on a NULL (LEFT JOIN miss) stays NULL.
    SUBSTR(r.display_name, 1, 512) AS "rootDisplayName",
    u.provider AS provider,
    u.model AS model,
    SUM(u.input_tokens)::bigint AS "inputTokens",
    SUM(u.output_tokens)::bigint AS "outputTokens",
    SUM(u.billed_cost_usd) AS "billedCostUsd",
    SUM(CASE WHEN u.billed_cost_usd IS NULL THEN u.input_tokens ELSE 0 END)::bigint
      AS "estimatedInputTokens",
    SUM(CASE WHEN u.billed_cost_usd IS NULL THEN u.output_tokens ELSE 0 END)::bigint
      AS "estimatedOutputTokens",
    SUM(CASE WHEN u.billed_cost_usd IS NULL THEN COALESCE(u.cache_read_input_tokens, 0) ELSE 0 END)::bigint
      AS "estimatedCacheReadTokens",
    SUM(CASE WHEN u.billed_cost_usd IS NULL THEN COALESCE(u.cache_creation_input_tokens, 0) ELSE 0 END)::bigint
      AS "estimatedCacheCreationTokens"
  FROM brainstrike_assistant_run_usage u
  LEFT JOIN roots r ON r.id = u.root_id
  WHERE u.resource_id = $1
  GROUP BY u.root_id, r.display_name, u.provider, u.model
  ORDER BY u.root_id ASC NULLS FIRST, u.provider ASC, u.model ASC
`;

/**
 * Strict parser for one aggregation row from CROSS_ROOT_USAGE_AGGREGATION_SQL.
 * Shared by the repo method and the live-query hook so the no-silent-fallbacks
 * contract holds on BOTH paths — a malformed/non-finite/negative aggregate or a
 * non-string provider/model THROWS rather than fabricating $0 / empty strings.
 * Callers must catch and surface a visible "couldn't load" state.
 */
export function mapCrossRootUsageRow(row: Record<string, unknown>): CrossRootUsageRow {
  const billedCostUsd = optionalNonNegativeFiniteNumber(row['billedCostUsd'], 'billedCostUsd');
  return {
    ...(billedCostUsd === undefined
      ? {}
      : {
          billedCostUsd,
          estimatedInputTokens: requireNonNegativeInteger(
            row['estimatedInputTokens'],
            'estimatedInputTokens'
          ),
          estimatedOutputTokens: requireNonNegativeInteger(
            row['estimatedOutputTokens'],
            'estimatedOutputTokens'
          ),
        }),
    estimatedCacheCreationTokens: requireNonNegativeInteger(
      row['estimatedCacheCreationTokens'] ?? 0,
      'estimatedCacheCreationTokens'
    ),
    estimatedCacheReadTokens: requireNonNegativeInteger(
      row['estimatedCacheReadTokens'] ?? 0,
      'estimatedCacheReadTokens'
    ),
    inputTokens: requireNonNegativeInteger(row['inputTokens'], 'inputTokens'),
    model: requireString(row['model'], 'model'),
    outputTokens: requireNonNegativeInteger(row['outputTokens'], 'outputTokens'),
    provider: requireString(row['provider'], 'provider'),
    // Defense for any non-SQL caller (the shared SQL already SUBSTRs to 512).
    rootDisplayName: boundedNullableString(row['rootDisplayName'], MAX_ROOT_DISPLAY_NAME_CHARS),
    rootId: nullableString(row['rootId']),
  };
}

export const RUN_LEDGER_DEFAULT_LIMIT = 200;

export const RUN_LEDGER_MAX_LIMIT = 1000;

export const RUN_OUTCOME_DETAIL_MAX_CHARS = 2000;

export const ASSISTANT_RUN_OUTCOME_SOURCES: readonly AssistantRunOutcomeSource[] = [
  'edit_revert',
  'hook',
  'user',
];

export const ASSISTANT_RUN_OUTCOME_VERDICTS: readonly AssistantRunOutcomeVerdict[] = [
  'failed',
  'mixed',
  'succeeded',
];

/**
 * Single source of truth for the Task Ledger aggregation (mirrors the
 * CROSS_ROOT_USAGE_AGGREGATION_SQL convention so a future reactive live-query
 * hook can never drift from the validated repo method).
 *
 * `$1` = resourceId, `$2` = limit. Each LEFT-JOINed subquery pre-groups its
 * fact table by run_id so one run yields exactly one row regardless of how
 * many usage/event/checkpoint rows it produced. Tool counts deliberately cover
 * only top-level `tool.*` events (subagent.tool.* belongs to the child run's
 * story, not the parent's v1 ledger). Outcome detail is display-bounded like
 * root display names.
 *
 * PARAM-REUSE CONSTRAINT: each bind parameter must appear EXACTLY ONCE. The
 * Task Ledger panel consumes this SQL through PGlite's live extension, whose
 * internal format() rewrite fails with "too few arguments for format()" when
 * a parameter is repeated — so the resource scope binds once in the `scope`
 * CTE and every fact table joins it. Regression-pinned by the live-query case
 * in assistant-memory-repository.integration.test.ts.
 */
export const RUN_LEDGER_AGGREGATION_SQL = `
  WITH scope AS (SELECT $1::text AS resource_id)
  SELECT
    tr.id AS "runId",
    tr.thread_id AS "threadId",
    tr.provider AS provider,
    tr.model AS model,
    tr.status AS status,
    tr.started_at AS "startedAt",
    tr.completed_at AS "completedAt",
    CASE
      WHEN tr.completed_at IS NULL THEN NULL
      -- GREATEST(0, …): a backward clock adjustment between start and finish
      -- must degrade to 0ms for ONE row, never throw and blank the whole ledger.
      ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (tr.completed_at - tr.started_at)) * 1000))::bigint
    END AS "durationMs",
    COALESCE(u.input_tokens, 0)::bigint AS "inputTokens",
    COALESCE(u.output_tokens, 0)::bigint AS "outputTokens",
    u.billed_cost_usd AS "billedCostUsd",
    COALESCE(u.estimated_input_tokens, 0)::bigint AS "estimatedInputTokens",
    COALESCE(u.estimated_output_tokens, 0)::bigint AS "estimatedOutputTokens",
    COALESCE(u.estimated_cache_read_tokens, 0)::bigint AS "estimatedCacheReadTokens",
    COALESCE(u.estimated_cache_creation_tokens, 0)::bigint AS "estimatedCacheCreationTokens",
    COALESCE(e.tool_call_count, 0)::bigint AS "toolCallCount",
    COALESCE(e.failed_tool_call_count, 0)::bigint AS "failedToolCallCount",
    COALESCE(c.edit_count, 0)::bigint AS "editCount",
    COALESCE(c.reverted_edit_count, 0)::bigint AS "revertedEditCount",
    o.verdict AS "outcomeVerdict",
    o.source AS "outcomeSource",
    SUBSTR(o.detail, 1, 512) AS "outcomeDetail"
  FROM brainstrike_assistant_thread_runs tr
  JOIN scope ON tr.resource_id = scope.resource_id
  LEFT JOIN (
    SELECT run_id,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(billed_cost_usd) AS billed_cost_usd,
      SUM(CASE WHEN billed_cost_usd IS NULL THEN input_tokens ELSE 0 END)
        AS estimated_input_tokens,
      SUM(CASE WHEN billed_cost_usd IS NULL THEN output_tokens ELSE 0 END)
        AS estimated_output_tokens,
      SUM(CASE WHEN billed_cost_usd IS NULL THEN COALESCE(cache_read_input_tokens, 0) ELSE 0 END)
        AS estimated_cache_read_tokens,
      SUM(CASE WHEN billed_cost_usd IS NULL THEN COALESCE(cache_creation_input_tokens, 0) ELSE 0 END)
        AS estimated_cache_creation_tokens
    FROM brainstrike_assistant_run_usage
    JOIN scope ON brainstrike_assistant_run_usage.resource_id = scope.resource_id
    GROUP BY run_id
  ) u ON u.run_id = tr.id
  LEFT JOIN (
    SELECT run_id,
      COUNT(*) FILTER (WHERE kind IN ('tool.completed', 'tool.failed')) AS tool_call_count,
      COUNT(*) FILTER (WHERE kind = 'tool.failed') AS failed_tool_call_count
    FROM brainstrike_assistant_run_events
    JOIN scope ON brainstrike_assistant_run_events.resource_id = scope.resource_id
    GROUP BY run_id
  ) e ON e.run_id = tr.id
  LEFT JOIN (
    SELECT run_id,
      COUNT(*) AS edit_count,
      COUNT(*) FILTER (WHERE reverted_at IS NOT NULL) AS reverted_edit_count
    FROM brainstrike_assistant_edit_checkpoints
    JOIN scope ON brainstrike_assistant_edit_checkpoints.resource_id = scope.resource_id
    GROUP BY run_id
  ) c ON c.run_id = tr.id
  LEFT JOIN brainstrike_assistant_run_outcomes o ON o.run_id = tr.id
  ORDER BY tr.started_at DESC, tr.id DESC
  LIMIT $2
`;

function nullableOutcomeSource(value: unknown): AssistantRunOutcomeSource | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value === 'string' &&
    (ASSISTANT_RUN_OUTCOME_SOURCES as readonly string[]).includes(value)
  ) {
    return value as AssistantRunOutcomeSource;
  }
  throw new Error(`Invalid run outcome source: ${String(value)}`);
}

function nullableOutcomeVerdict(value: unknown): AssistantRunOutcomeVerdict | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value === 'string' &&
    (ASSISTANT_RUN_OUTCOME_VERDICTS as readonly string[]).includes(value)
  ) {
    return value as AssistantRunOutcomeVerdict;
  }
  throw new Error(`Invalid run outcome verdict: ${String(value)}`);
}

function nullableNonNegativeInteger(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireNonNegativeInteger(value, fieldName);
}

/**
 * Strict parser for one RUN_LEDGER_AGGREGATION_SQL row. Shared for the same
 * reason as mapCrossRootUsageRow: no silent fallbacks on ANY consumer — a
 * malformed aggregate throws rather than fabricating zeros, and callers must
 * surface a visible "couldn't load" state.
 */
export function mapRunLedgerRow(row: Record<string, unknown>): RunLedgerRow {
  const billedCostUsd = optionalNonNegativeFiniteNumber(row['billedCostUsd'], 'billedCostUsd');
  return {
    ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
    completedAt: normalizeNullableDate(row['completedAt']),
    durationMs: nullableNonNegativeInteger(row['durationMs'], 'durationMs'),
    editCount: requireNonNegativeInteger(row['editCount'], 'editCount'),
    estimatedCacheCreationTokens: requireNonNegativeInteger(
      row['estimatedCacheCreationTokens'] ?? 0,
      'estimatedCacheCreationTokens'
    ),
    estimatedCacheReadTokens: requireNonNegativeInteger(
      row['estimatedCacheReadTokens'] ?? 0,
      'estimatedCacheReadTokens'
    ),
    estimatedInputTokens: requireNonNegativeInteger(
      row['estimatedInputTokens'],
      'estimatedInputTokens'
    ),
    estimatedOutputTokens: requireNonNegativeInteger(
      row['estimatedOutputTokens'],
      'estimatedOutputTokens'
    ),
    failedToolCallCount: requireNonNegativeInteger(
      row['failedToolCallCount'],
      'failedToolCallCount'
    ),
    inputTokens: requireNonNegativeInteger(row['inputTokens'], 'inputTokens'),
    model: requireString(row['model'], 'model'),
    outcomeDetail: nullableString(row['outcomeDetail']),
    outcomeSource: nullableOutcomeSource(row['outcomeSource']),
    outcomeVerdict: nullableOutcomeVerdict(row['outcomeVerdict']),
    outputTokens: requireNonNegativeInteger(row['outputTokens'], 'outputTokens'),
    provider: requireString(row['provider'], 'provider'),
    revertedEditCount: requireNonNegativeInteger(row['revertedEditCount'], 'revertedEditCount'),
    runId: requireString(row['runId'], 'runId'),
    startedAt: normalizeDate(row['startedAt']),
    status: requireRunStatus(row['status']),
    threadId: requireString(row['threadId'], 'threadId'),
    toolCallCount: requireNonNegativeInteger(row['toolCallCount'], 'toolCallCount'),
  };
}
