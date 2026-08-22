import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/assistant-contract';
import {
  ASSISTANT_EDIT_CHECKPOINT_CAPTURE_STATUSES,
  ASSISTANT_EDIT_CHECKPOINT_OPS,
  type AssistantEditCheckpointCaptureStatus,
  type AssistantEditCheckpointOp,
  type AssistantEditCheckpointRecord,
  isGuardedToolError,
} from '@brainstrike/assistant-contract';
import {
  isApprovalActionMessage,
  readActionMessageRunId,
} from '@brainstrike/assistant-contract/approval-action-message';
import {
  ASSISTANT_COMPACTION_RANGES_TABLE,
  ASSISTANT_MESSAGE_TOMBSTONES_TABLE,
  ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE,
  CANVAS_VERSIONS_TABLE,
  DEFAULT_THREAD_TITLE,
  MASTRA_MEMORY_SCHEMA_SQL,
  MASTRA_MEMORY_TABLES,
  MIND_OPS_TABLE,
  THREAD_DELETE_SIDECAR_TABLES,
  THREAD_TITLE_SOURCE_METADATA_KEY,
  THREAD_TITLE_SOURCE_OM,
  TOKEN_ESTIMATE_CALIBRATION_TABLE,
  TOOL_CALL_TELEMETRY_TABLE,
  WORKSPACE_SNAPSHOTS_TABLE,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  ASSISTANT_RUN_EVENT_KINDS,
  ASSISTANT_RUN_EVENT_STATUSES,
  type AssistantRunEvent,
  type AssistantRunEventKind,
  type AssistantRunEventStatus,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';
import {
  ASSISTANT_RUN_USAGE_KINDS,
  type AssistantRunUsageKind,
} from '@brainstrike/assistant-contract/run-usage';
import {
  type RediscoveredToolApproval,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import {
  type RediscoveredToolSuspend,
  TOOL_SUSPEND_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-suspend';
import type { DbHandle } from '@brainstrike/db/react';
import type { SuspendedRunDiscovery } from './assistant-suspended-approvals';

export interface AssistantMemoryThread {
  readonly createdAt: Date;
  readonly id: string;
  readonly latestRun?: AssistantThreadRunRecord;
  readonly metadata?: AssistantThreadMetadata;
  readonly resourceId: string;
  readonly title: string;
  readonly updatedAt: Date;
}

export const ASSISTANT_THREAD_ICON_IDS = [
  'message',
  'bug',
  'code',
  'rocket',
  'research',
  'plan',
] as const;

export const ASSISTANT_THREAD_COLOR_IDS = [
  'blue',
  'emerald',
  'amber',
  'rose',
  'violet',
  'slate',
] as const;

export type AssistantThreadIconId = (typeof ASSISTANT_THREAD_ICON_IDS)[number];
export type AssistantThreadColorId = (typeof ASSISTANT_THREAD_COLOR_IDS)[number];

export interface AssistantThreadMetadata {
  readonly color?: AssistantThreadColorId;
  readonly icon?: AssistantThreadIconId;
  readonly model?: string;
  readonly modelSettings?: Record<string, unknown>;
  /** Human-readable label retained for a stable historical thread scope chip. */
  readonly operatingRootDisplayName?: string;
  /** Durable DB roots.id used as the authoritative native-tool binding. */
  readonly operatingRootId?: string;
  /** Absolute path retained for the scope chip tooltip; never used as authority. */
  readonly operatingRootPath?: string;
  readonly provider?: string;
  readonly providerOptions?: Record<string, unknown>;
  /**
   * Durable DB `roots.id` values of the thread's SECONDARY folders (the
   * primary is `operatingRootId`). Display + per-thread folder set only:
   * tool scope still follows the server's workspace-root inventory.
   */
  readonly secondaryRootIds?: readonly string[];
  readonly source?: string;
}

type MutableAssistantThreadMetadata = {
  -readonly [Key in keyof AssistantThreadMetadata]?: AssistantThreadMetadata[Key];
};

export type AssistantThreadRunStatus = 'cancelled' | 'completed' | 'failed' | 'running';
export type AssistantThreadRuntimeKind = 'browser' | 'gateway' | 'hosted' | 'local';

export interface AssistantThreadRunRecord {
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly error: string | null;
  readonly id: string;
  readonly model: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly provider: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly resourceId: string;
  readonly runtimeKind: AssistantThreadRuntimeKind;
  readonly startedAt: Date;
  readonly status: AssistantThreadRunStatus;
  readonly threadId: string;
  /**
   * The user message whose turn this run belongs to (BST-1163). Written at
   * run creation — every leg of one turn (initial send, approval/suspend
   * resumes) carries the SAME triggering user message id, so rewind range
   * resolution can group runs by turn instead of guessing from timestamps.
   * `null` for rows that predate the column (readers fall back to the
   * completed_at rule) and for callers with no message in hand.
   */
  readonly turnMessageId: string | null;
  readonly updatedAt: Date;
}

export interface CreateAssistantThreadRunInput {
  readonly completedAt?: Date | null;
  readonly error?: string | null;
  readonly id: string;
  readonly model: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly provider: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly resourceId: string;
  readonly runtimeKind: AssistantThreadRuntimeKind;
  readonly startedAt?: Date;
  readonly status?: AssistantThreadRunStatus;
  readonly threadId: string;
  /** See {@link AssistantThreadRunRecord.turnMessageId}. Omitted ⇒ NULL. */
  readonly turnMessageId?: string | null;
}

export interface CompleteAssistantThreadRunInput {
  readonly error?: string | null;
  readonly status: Exclude<AssistantThreadRunStatus, 'running'>;
}

/**
 * One durable token-usage record. model/provider are stored PER ROW because a
 * thread can switch models mid-conversation; cost must be computed per row
 * against that row's pricing and summed, never against the thread's current
 * model.
 */
export interface RecordRunUsageInput {
  /** Exact amount billed by the provider for this run, when reported. */
  readonly billedCostUsd?: number;
  /**
   * Anthropic prompt-cache write tokens. `inputTokens` is the TOTAL the model
   * saw and already includes both cache classes.
   */
  readonly cacheCreationInputTokens?: number;
  /** Anthropic prompt-cache read tokens (same total-inclusive contract). */
  readonly cacheReadInputTokens?: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
  readonly resourceId: string;
  /**
   * Workspace ROOT this run was focused on, snapshotted at request start.
   * Null/undefined when no root is focused — an honest "unattributed" bucket,
   * NOT a fake root (no silent fallback).
   */
  readonly rootId?: string | null;
  readonly runId: string;
  /**
   * Which kind of model call produced this row (BST-953). Defaults to 'chat'
   * (the parent assistant turn); child rows ('subagent', 'om-observation',
   * 'om-reflection') carry the parent run's id so the Task Ledger's per-run
   * totals include them.
   */
  readonly runKind?: AssistantRunUsageKind;
  readonly threadId: string;
}

/**
 * One per-(root, provider, model) durable usage subtotal for a workspace
 * (resourceId). `rootId` is null for runs that had no focused root.
 * `rootDisplayName` is the root's human name from the joined `roots` row, or
 * null when the root id is the null bucket or the join misses (e.g. a legacy
 * path-remapped id). Cost is priced per (root, model) then summed per root —
 * never cumulative tokens against a single price.
 */
export interface CrossRootUsageRow {
  readonly billedCostUsd?: number;
  /** Anthropic cache-write share of the estimated (unbilled) input tokens. */
  readonly estimatedCacheCreationTokens?: number;
  /** Anthropic cache-read share of the estimated (unbilled) input tokens. */
  readonly estimatedCacheReadTokens?: number;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
  readonly rootDisplayName: string | null;
  readonly rootId: string | null;
}

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

/** Provenance of a run outcome label — never lost, so "who said it failed" is always answerable. */
export type AssistantRunOutcomeSource = 'edit_revert' | 'hook' | 'user';

/** The outcome label itself: did the run's WORK succeed (vs transport status). */
export type AssistantRunOutcomeVerdict = 'failed' | 'mixed' | 'succeeded';

export interface RecordRunOutcomeInput {
  readonly detail?: string;
  readonly labeledAt?: Date;
  readonly resourceId: string;
  readonly runId: string;
  readonly source: AssistantRunOutcomeSource;
  readonly threadId: string;
  readonly verdict: AssistantRunOutcomeVerdict;
}

export interface RunLedgerListOptions {
  /** Newest-first bound on returned runs; defaults to RUN_LEDGER_DEFAULT_LIMIT. */
  readonly limitLatest?: number;
}

/**
 * One Task Ledger row: a run joined with its usage totals, tool-call counts,
 * edit-checkpoint revert signals, and outcome label. `billedCostUsd` is absent
 * (never fabricated 0) when no usage row carried an exact provider-reported
 * cost. `durationMs` is null while the run is still open.
 */
export interface RunLedgerRow {
  readonly billedCostUsd?: number;
  readonly completedAt: Date | null;
  readonly durationMs: number | null;
  readonly editCount: number;
  /** Anthropic cache-write share of `estimatedInputTokens` (0 elsewhere). */
  readonly estimatedCacheCreationTokens: number;
  /** Anthropic cache-read share of `estimatedInputTokens` (0 elsewhere). */
  readonly estimatedCacheReadTokens: number;
  /**
   * Tokens from usage rows WITHOUT a provider-reported cost (always emitted,
   * unlike CrossRootUsageRow's billed-anchored optionality): `billedCostUsd`
   * covers only the reported rows, so a mixed run's exact figure is PARTIAL —
   * consumers must price/mark this remainder rather than presenting the billed
   * portion as the whole cost.
   */
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly failedToolCallCount: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outcomeDetail: string | null;
  readonly outcomeSource: AssistantRunOutcomeSource | null;
  readonly outcomeVerdict: AssistantRunOutcomeVerdict | null;
  readonly outputTokens: number;
  readonly provider: string;
  readonly revertedEditCount: number;
  readonly runId: string;
  readonly startedAt: Date;
  readonly status: AssistantThreadRunStatus;
  readonly threadId: string;
  readonly toolCallCount: number;
}

export const RUN_LEDGER_DEFAULT_LIMIT = 200;
const RUN_LEDGER_MAX_LIMIT = 1000;
const RUN_OUTCOME_DETAIL_MAX_CHARS = 2000;

const ASSISTANT_RUN_OUTCOME_SOURCES: readonly AssistantRunOutcomeSource[] = [
  'edit_revert',
  'hook',
  'user',
];
const ASSISTANT_RUN_OUTCOME_VERDICTS: readonly AssistantRunOutcomeVerdict[] = [
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

/** Per-(model, run-kind) token subtotal for a single thread. */
export interface ThreadModelUsageSubtotal {
  readonly billedCostUsd?: number;
  /**
   * Prompt-cache write tokens across ALL rows (billed and unbilled) — the
   * savings line needs cache classes even when the provider reported an exact
   * cost. Share of `inputTokens`.
   */
  readonly cacheCreationTokens: number;
  /** Prompt-cache read tokens across ALL rows (same total-inclusive contract). */
  readonly cacheReadTokens: number;
  /** Anthropic cache-write share of the estimated (unbilled) input tokens. */
  readonly estimatedCacheCreationTokens?: number;
  /** Anthropic cache-read share of the estimated (unbilled) input tokens. */
  readonly estimatedCacheReadTokens?: number;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
  /** Which kind of model call produced this subtotal (BST-953). */
  readonly runKind: AssistantRunUsageKind;
}

/**
 * Cumulative durable token usage for a thread. `perModel` carries the
 * per-(provider, model, runKind) subtotals so the UI can price each model with
 * its own registry rate, sum, and break the thread total down by source — the
 * thread totals alone cannot be priced when the thread mixed models.
 */
export interface ThreadCumulativeUsage {
  readonly perModel: readonly ThreadModelUsageSubtotal[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

export interface AssistantThreadRepository {
  appendThreadRunEvent: (runId: string, event: AssistantRunEvent) => Promise<void>;
  completeThreadRun: (runId: string, input: CompleteAssistantThreadRunInput) => Promise<void>;
  createThread: (resourceId: string, title?: string) => Promise<AssistantMemoryThread>;
  createThreadRun: (input: CreateAssistantThreadRunInput) => Promise<AssistantThreadRunRecord>;
  deleteThread: (threadId: string) => Promise<void>;
  deleteThreads?: (threadIds: readonly string[]) => Promise<void>;
  getCrossRootUsage: (resourceId: string) => Promise<readonly CrossRootUsageRow[]>;
  /** Task Ledger read model. Optional only for read-only/test repositories. */
  getRunLedger?: (
    resourceId: string,
    options?: RunLedgerListOptions
  ) => Promise<readonly RunLedgerRow[]>;
  getThreadCumulativeUsage: (threadId: string) => Promise<ThreadCumulativeUsage | null>;
  /**
   * BST-1163 run↔turn link, read by the history adapter's suspended-edge
   * backfill (BST-1243). Optional only for read-only/test repositories.
   */
  getThreadRunTurnMessageId?: (runId: string, threadId: string) => Promise<string | null>;
  listLatestThreadRuns: (resourceId: string) => Promise<readonly AssistantThreadRunRecord[]>;
  listMessages: (
    threadId: string,
    resourceId: string,
    options?: AssistantThreadMessageListOptions
  ) => Promise<readonly AssistantHistoryMessage[]>;
  listThreadCheckpoints: (threadId: string) => Promise<readonly AssistantEditCheckpointRecord[]>;
  listThreadRunEvents: (
    threadId: string,
    resourceId: string,
    options?: AssistantThreadRunEventListOptions
  ) => Promise<readonly AssistantRunEvent[]>;
  listThreads: (resourceId: string) => Promise<readonly AssistantMemoryThread[]>;
  /** Required by history-adapter append; optional only for read-only/test repositories. */
  recordMessageParent?: (input: RecordAssistantMessageParentInput) => Promise<void>;
  /** Task Ledger: upsert the per-run outcome label. Optional only for read-only/test repositories. */
  recordRunOutcome?: (input: RecordRunOutcomeInput) => Promise<void>;
  recordRunUsage: (input: RecordRunUsageInput) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  updateThreadMetadata: (threadId: string, metadata: AssistantThreadMetadata) => Promise<void>;
  updateThreadsMetadata?: (
    threadIds: readonly string[],
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
}

export interface BulkAssistantThreadRepository extends AssistantThreadRepository {
  deleteThreads: (threadIds: readonly string[]) => Promise<void>;
  getRunLedger: (
    resourceId: string,
    options?: RunLedgerListOptions
  ) => Promise<readonly RunLedgerRow[]>;
  recordRunOutcome: (input: RecordRunOutcomeInput) => Promise<void>;
  updateThreadsMetadata: (
    threadIds: readonly string[],
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
}

interface AssistantHistoryMessage {
  readonly content: unknown;
  readonly createdAt: Date;
  readonly id: string;
  /** Undefined only for legacy rows written before durable branch topology. */
  readonly parentId?: string | null;
  readonly role: string;
}

export interface RecordAssistantMessageParentInput {
  readonly messageId: string;
  readonly parentId: string | null;
  readonly resourceId: string;
  readonly threadId: string;
}

export interface AssistantThreadMessageListOptions {
  readonly limitLatest?: number;
}

export interface AssistantThreadRunEventListOptions {
  readonly limitLatestRuns?: number;
}

export const ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT = 80;

const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';
const LATEST_THREAD_RUNS_BY_RESOURCE_SQL = `SELECT DISTINCT ON (thread_id)
    id,
    resource_id,
    thread_id,
    provider,
    model,
    model_settings,
    provider_options,
    runtime_kind,
    status,
    error,
    started_at,
    completed_at,
    created_at,
    updated_at,
    turn_message_id
  FROM ${ASSISTANT_THREAD_RUNS_TABLE}
  WHERE resource_id = $1
  ORDER BY thread_id, started_at DESC, id DESC`;
const ASSISTANT_RUN_EVENTS_TABLE = 'brainstrike_assistant_run_events';
const ASSISTANT_RUN_USAGE_TABLE = 'brainstrike_assistant_run_usage';
const ASSISTANT_EDIT_CHECKPOINTS_TABLE = 'brainstrike_assistant_edit_checkpoints';
const ASSISTANT_RUN_OUTCOMES_TABLE = 'brainstrike_assistant_run_outcomes';
const ASSISTANT_RUN_TREATMENTS_TABLE = 'brainstrike_assistant_run_treatments';
const ASSISTANT_RUN_ERRORS_TABLE = 'brainstrike_assistant_run_errors';
const ASSISTANT_MESSAGE_PARENTS_TABLE = 'brainstrike_assistant_message_parents';
/**
 * Built ON DEMAND, deliberately NOT as a module-scope constant.
 *
 * This template interpolates two bindings imported from
 * `@brainstrike/assistant-contract/mastra-memory-schema`:
 * `MASTRA_MEMORY_SCHEMA_SQL` and `MASTRA_MEMORY_TABLES.threads`. Evaluating it
 * at module scope reads them during CHUNK INITIALIZATION, and the renderer's
 * bundle chunk graph does not guarantee the contract chunk has been evaluated by
 * that point. When it has not, `MASTRA_MEMORY_TABLES` is still `undefined` and
 * interpolating its `.threads` property throws "Cannot read properties of
 * undefined (reading 'threads')" while this module is evaluating — the renderer
 * dies at startup and the app never becomes ready.
 *
 * Measured, not theorised (BST-558): adding one unrelated static import of that
 * same contract module to `packages/db/src/db-provider.tsx` reordered chunk init
 * and turned Web + Desktop E2E red where the preceding commit was green, while
 * type-check, lint and every unit suite stayed green throughout. The schema
 * module imports nothing, so there is no source cycle for any static analysis to
 * find — only the bundler's chunk graph decides this, and only a production
 * build exhibits it.
 *
 * Deferring the reads into a function body is the durable fix: by the time
 * `initialize()` calls this, every chunk has been evaluated, so NO import order
 * can leave the bindings undefined. Keep it a function — do not "optimize" it
 * back into a module-scope constant or a module-scope memo.
 *
 * Interpolating `MASTRA_MEMORY_SCHEMA_SQL` is the more insidious of the two
 * reads: an uninitialized binding there does not throw, it splices the literal
 * string "undefined" into the DDL.
 */
export function buildAssistantThreadRunsSchemaSql(): string {
  return `
${MASTRA_MEMORY_SCHEMA_SQL}

-- assistant-ui's branch graph is client-owned topology layered over Mastra's
-- durable message content. A parent row may be written before its Mastra
-- message row, so message_id/parent_id intentionally have no message FK.
CREATE TABLE IF NOT EXISTS ${ASSISTANT_MESSAGE_PARENTS_TABLE} (
  message_id text PRIMARY KEY,
  thread_id text NOT NULL,
  resource_id text NOT NULL,
  parent_id text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_message_parents_thread_idx
  ON ${ASSISTANT_MESSAGE_PARENTS_TABLE} (thread_id, resource_id);

-- Soft-rewind tombstones (BST-1115). Bootstrapped here AND created by
-- migration 080 — keep the shape byte-identical to 080. A tombstoned message
-- keeps its Mastra content row and is excluded by every Brainstrike-owned
-- read; the row is hard-deleted when the next user message finalizes the
-- rewind. message_id is the PK: a message is tombstoned at most once, which is
-- what makes deleting a rewind_id batch an exact redo. rewind_id is the redo
-- key and exists in both rewind modes; revert_id links the paired journal file
-- revert and is NULL for a conversation-only rewind.
CREATE TABLE IF NOT EXISTS ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} (
  message_id text PRIMARY KEY,
  thread_id text NOT NULL,
  rewind_id text NOT NULL,
  revert_id text,
  tombstoned_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_message_tombstones_thread_idx
  ON ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} (thread_id);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_message_tombstones_rewind_idx
  ON ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} (rewind_id);

-- Shadow-git snapshot ledger (BST-1164 W7). Bootstrapped here AND created by
-- migration 081 — keep the shape byte-identical to 081. Mirrored because the
-- thread-delete cascade CTEs below reference every sidecar table
-- unconditionally, so the relation must exist wherever this repository runs.
-- id is an app-side uuidv7 (migration 080's caller-supplied-text-PK
-- convention); run_id is nullable provenance (a turn is not a run); kind is
-- CHECK-constrained (migration 079's closed-vocabulary convention).
CREATE TABLE IF NOT EXISTS ${WORKSPACE_SNAPSHOTS_TABLE} (
  id text PRIMARY KEY,
  thread_id text NOT NULL,
  run_id text,
  root_id text NOT NULL,
  root_path text NOT NULL,
  commit_oid text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('turn-start', 'turn-end', 'pre-revert')),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brainstrike_workspace_snapshots_thread_idx
  ON ${WORKSPACE_SNAPSHOTS_TABLE} (thread_id, created_at);

CREATE INDEX IF NOT EXISTS brainstrike_workspace_snapshots_root_idx
  ON ${WORKSPACE_SNAPSHOTS_TABLE} (root_id);

-- Persisted Canvas document versions (BST-1173). Bootstrapped here AND
-- created by migration 082 — keep the shape byte-identical to 082. Mirrored
-- because the thread-delete cascade references every sidecar unconditionally.
-- ids are app-side uuidv7 values; creator is a closed vocabulary; the newest
-- version for one canvas is its current content.
CREATE TABLE IF NOT EXISTS ${CANVAS_VERSIONS_TABLE} (
  id text PRIMARY KEY,
  canvas_id text NOT NULL,
  thread_id text NOT NULL,
  resource_id text NOT NULL,
  title text NOT NULL,
  html text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  created_by text NOT NULL CHECK (created_by IN ('assistant', 'user')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (canvas_id, version)
);

CREATE INDEX IF NOT EXISTS brainstrike_canvas_versions_thread_idx
  ON ${CANVAS_VERSIONS_TABLE} (thread_id);

CREATE INDEX IF NOT EXISTS brainstrike_canvas_versions_canvas_version_idx
  ON ${CANVAS_VERSIONS_TABLE} (canvas_id, version DESC);

-- Privacy-safe per-tool model-output telemetry (BST-1190). Bootstrapped here
-- AND created by migrations 083 (table + thread/tool_time indexes), 085
-- (occurred_at index, BST-1198), and 092 (substrate-split columns,
-- BST-1247) — keep the shape byte-identical to all three.
-- Mirrored because the thread-delete cascade references every sidecar
-- unconditionally; only desktop main writes rows during normal operation.
CREATE TABLE IF NOT EXISTS ${TOOL_CALL_TELEMETRY_TABLE} (
  id text PRIMARY KEY,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  tool_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT NOW(),
  model_facing_chars integer NOT NULL CHECK (model_facing_chars >= 0),
  truncated boolean NOT NULL DEFAULT false,
  zero_match boolean,
  is_pagination_followup boolean NOT NULL DEFAULT false,
  -- Migration 092 (BST-1247): substrate degradation split out of truncated
  -- so the waste lens can separate model behavior from engine degradation.
  engine text,
  scan_limited boolean NOT NULL DEFAULT false,
  candidates_truncated boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS brainstrike_tool_call_telemetry_thread_idx
  ON ${TOOL_CALL_TELEMETRY_TABLE} (thread_id);

CREATE INDEX IF NOT EXISTS brainstrike_tool_call_telemetry_tool_time_idx
  ON ${TOOL_CALL_TELEMETRY_TABLE} (tool_id, occurred_at DESC);

-- Migration 085 (BST-1198): occurred_at-leading index for the scheduled
-- retention sweep, which filters on occurred_at alone (no tool_id predicate).
CREATE INDEX IF NOT EXISTS brainstrike_tool_call_telemetry_occurred_at_idx
  ON ${TOOL_CALL_TELEMETRY_TABLE} (occurred_at);

-- Estimator-vs-provider prompt-token reconciliation pairs (BST-1205).
-- Bootstrapped here AND created by migrations 086 + 089 + 091 — keep the shape
-- byte-identical. The numerator is the chars/4 backstop over model-visible tool
-- outputs plus tool definitions, each counted once. final_step_prompt_tokens is
-- the latest step prompt, which contains prior tool outputs once via Mastra's
-- resend behavior—not the cross-step accumulated total. Conversation/system
-- prompt text outside tool outputs/definitions is excluded from both. Only
-- completed runs with at least one measured tool output are written. The
-- nullable resolved-budget columns segment new samples by their actual run
-- tier. prompt_baseline_tokens records system instructions + task list + tool
-- definitions for the same run, so the next turn's compaction trigger can
-- account for prompt content unavailable at its pre-request seam. Historical/
-- bootstrap-upgrade rows remain NULL rather than guessed.
-- Mirrored because thread deletion references every sidecar unconditionally;
-- only desktop main writes rows during normal operation.
CREATE TABLE IF NOT EXISTS ${TOKEN_ESTIMATE_CALIBRATION_TABLE} (
  id text PRIMARY KEY,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  estimated_prompt_tokens integer NOT NULL CHECK (estimated_prompt_tokens >= 0),
  final_step_prompt_tokens integer NOT NULL CHECK (final_step_prompt_tokens >= 0),
  step_count integer NOT NULL DEFAULT 1 CHECK (step_count >= 1),
  model_visible_projection_count integer NOT NULL DEFAULT 0 CHECK (model_visible_projection_count >= 0),
  occurred_at timestamptz NOT NULL DEFAULT NOW(),
  resolved_domain_budget_tokens integer CHECK (resolved_domain_budget_tokens IS NULL OR resolved_domain_budget_tokens > 0),
  resolved_transport_budget_tokens integer CHECK (resolved_transport_budget_tokens IS NULL OR resolved_transport_budget_tokens > 0),
  prompt_baseline_tokens integer CHECK (prompt_baseline_tokens IS NULL OR prompt_baseline_tokens > 0)
);

ALTER TABLE ${TOKEN_ESTIMATE_CALIBRATION_TABLE}
  ADD COLUMN IF NOT EXISTS resolved_domain_budget_tokens integer
    CHECK (resolved_domain_budget_tokens IS NULL OR resolved_domain_budget_tokens > 0),
  ADD COLUMN IF NOT EXISTS resolved_transport_budget_tokens integer
    CHECK (resolved_transport_budget_tokens IS NULL OR resolved_transport_budget_tokens > 0),
  ADD COLUMN IF NOT EXISTS prompt_baseline_tokens integer
    CHECK (prompt_baseline_tokens IS NULL OR prompt_baseline_tokens > 0);

CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_thread_idx
  ON ${TOKEN_ESTIMATE_CALIBRATION_TABLE} (thread_id);

CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_model_idx
  ON ${TOKEN_ESTIMATE_CALIBRATION_TABLE} (model, occurred_at DESC);

CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_occurred_at_idx
  ON ${TOKEN_ESTIMATE_CALIBRATION_TABLE} (occurred_at);

-- Native-tool model-projection overlays (BST-1192/BST-1200). Bootstrapped
-- here AND created by migrations 084 + 087 — this renderer-executed bootstrap
-- covers a FRESH table (CREATE TABLE branch) with the final shape, and adds
-- the ONLY column an already-084-shaped table can be missing (ADD COLUMN IF
-- NOT EXISTS is additive, never destructive). It deliberately does NOT run
-- ALTER COLUMN superseded_by_tool_call_id DROP NOT NULL, nor ADD CONSTRAINT
-- brainstrike_tool_projection_rewrite_kind_superseder_check: this SQL string
-- executes through the desktop renderer's db:exec IPC channel, and
-- db-ipc.ts's assertRendererSql guard (DESTRUCTIVE_SCHEMA_SQL_PATTERN)
-- matches ANY 'ALTER TABLE ... DROP ...' statement (including DROP NOT
-- NULL) as destructive schema SQL and rejects it outright, which broke
-- thread loading (and therefore the whole assistant panel mount) for every
-- desktop user until this was caught by a hard E2E failure (BST-1200 PR
-- #2355 review; do NOT reintroduce a nested backtick in this comment block,
-- it prematurely terminates the enclosing TS template literal and breaks the
-- build). Desktop main's migration 087 (both runners) is already
-- authoritative for the nullable column and CHECK constraint on desktop:
-- Electron main's own PGlite connection runs migrations directly, with no
-- IPC boundary and no db-ipc.ts guard in the way. "only desktop main
-- writes rows during normal operation" (below) means web never inserts a
-- kind = 'prune' row, so an un-relaxed NOT NULL here is harmless on web:
-- the thread-delete cascade only needs the TABLE and the kind COLUMN to
-- exist, never the exact constraint topology.
CREATE TABLE IF NOT EXISTS ${ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE} (
  tool_call_id text PRIMARY KEY,
  thread_id text NOT NULL,
  rewrite_id text NOT NULL,
  superseded_by_tool_call_id text,
  kind text NOT NULL DEFAULT 'supersession'
    CHECK (kind IN ('supersession', 'prune')),
  marker_text text NOT NULL,
  original_chars integer NOT NULL CHECK (original_chars >= 0),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT brainstrike_tool_projection_rewrite_kind_superseder_check
    CHECK (
      (kind = 'supersession' AND superseded_by_tool_call_id IS NOT NULL)
      OR (kind = 'prune' AND superseded_by_tool_call_id IS NULL)
    )
);

ALTER TABLE ${ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE}
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'supersession'
  CHECK (kind IN ('supersession', 'prune'));

CREATE INDEX IF NOT EXISTS brainstrike_assistant_tool_projection_rewrites_thread_idx
  ON ${ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE} (thread_id);

-- Durable conversation-compaction ranges (BST-1200 Milestone 2).
-- Bootstrapped here AND created by migration 088 — keep the shape
-- byte-identical. The exact ordered message-id set is stored because Mastra
-- message ids are opaque client strings / UUIDv4 values, not sortable range
-- keys. Mirrored because thread deletion references every sidecar
-- unconditionally; only desktop main writes rows during normal operation.
CREATE TABLE IF NOT EXISTS ${ASSISTANT_COMPACTION_RANGES_TABLE} (
  compaction_message_id text PRIMARY KEY,
  thread_id text NOT NULL,
  compacted_message_ids jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('agentic', 'deterministic')),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_compaction_ranges_thread_idx
  ON ${ASSISTANT_COMPACTION_RANGES_TABLE} (thread_id);

CREATE TABLE IF NOT EXISTS ${ASSISTANT_THREAD_RUNS_TABLE} (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  thread_id text NOT NULL REFERENCES ${MASTRA_MEMORY_TABLES.threads}(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  model_settings jsonb,
  provider_options jsonb,
  runtime_kind text NOT NULL,
  status text NOT NULL,
  error text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  turn_message_id text
);

-- Run↔turn link (BST-1163): the user message whose turn the run belongs to,
-- written at run creation. Nullable — pre-1163 rows stay NULL and readers
-- fall back to the completed_at timestamp rule. Upgrade path for existing
-- installs (this table is bootstrap-only; no numbered migration exists or
-- may be added — see assistant-persistence.md).
ALTER TABLE ${ASSISTANT_THREAD_RUNS_TABLE}
  ADD COLUMN IF NOT EXISTS turn_message_id text;

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_resource_idx
  ON ${ASSISTANT_THREAD_RUNS_TABLE} (resource_id);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_thread_latest_idx
  ON ${ASSISTANT_THREAD_RUNS_TABLE} (resource_id, thread_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_status_idx
  ON ${ASSISTANT_THREAD_RUNS_TABLE} (status);

CREATE TABLE IF NOT EXISTS ${ASSISTANT_RUN_EVENTS_TABLE} (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES ${ASSISTANT_THREAD_RUNS_TABLE}(id) ON DELETE CASCADE,
  resource_id text NOT NULL,
  thread_id text NOT NULL REFERENCES ${MASTRA_MEMORY_TABLES.threads}(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  label text NOT NULL,
  detail text,
  duration_ms integer,
  metadata jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_thread_idx
  ON ${ASSISTANT_RUN_EVENTS_TABLE} (thread_id, resource_id, sequence ASC, occurred_at ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_run_idx
  ON ${ASSISTANT_RUN_EVENTS_TABLE} (run_id, sequence ASC, occurred_at ASC);

-- Threads-panel "needs you" projection (BST-1404). Both indexes above lead with
-- thread_id or run_id, so that query — which is resource-scoped and kind-scoped
-- — full-scanned the largest assistant table on BOTH sides of its anti-join, on
-- every run_events notify. These two partial indexes cover the two sides. They
-- live HERE and only here: this table is created solely by this bootstrap and
-- must never get a numbered migration (see docs/agents/assistant-persistence.md,
-- RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP), and IF NOT EXISTS re-runs on every
-- handle init, so existing installs pick them up — the same upgrade path as the
-- turn_message_id ADD COLUMN above.
CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_pause_idx
  ON ${ASSISTANT_RUN_EVENTS_TABLE} (resource_id, thread_id)
  WHERE kind = 'tool.approval.requested';

-- The anti-join side. Keyed additionally on the extracted toolCallId, which is
-- the equality the NOT EXISTS pairs on; jsonb ->> is immutable, so it is
-- indexable as an expression. run_id trails it because the anti-join also
-- excludes the SAME-run tool.started the pausing leg emits before the pause
-- (Mastra gates inside toolCallStep); carrying it here keeps that exclusion on
-- the index rather than sending every candidate row to a heap fetch.
CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_answer_idx
  ON ${ASSISTANT_RUN_EVENTS_TABLE} (resource_id, thread_id, (metadata->>'toolCallId'), run_id)
  WHERE kind IN ('tool.started', 'tool.completed', 'tool.failed', 'tool.resume.unsupported');

-- Terminal provider forensics (Flight Recorder P3). Bootstrapped here and
-- created by migration 076; keep the table/index shape byte-identical to that
-- migration. There is intentionally no FK because the numbered runner has no
-- thread_runs parent. The canonical DB repository derives thread/resource from
-- the durable parent and throws if it is missing. One row per run is immutable
-- first-terminal-wins; no dishonest partial retry-attempt history is stored.
CREATE TABLE IF NOT EXISTS ${ASSISTANT_RUN_ERRORS_TABLE} (
  run_id              TEXT PRIMARY KEY,
  thread_id           TEXT NOT NULL,
  resource_id         TEXT NOT NULL,
  code                TEXT NOT NULL,
  message             TEXT,
  cause_chain         JSONB,
  http_status         INTEGER,
  provider_request_id TEXT,
  response_headers    JSONB,
  occurred_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bst_assistant_run_errors_run_check
    CHECK (length(run_id) > 0),
  CONSTRAINT bst_assistant_run_errors_thread_check
    CHECK (length(thread_id) > 0),
  CONSTRAINT bst_assistant_run_errors_resource_check
    CHECK (length(resource_id) > 0),
  CONSTRAINT bst_assistant_run_errors_code_check
    CHECK (length(code) > 0),
  CONSTRAINT bst_assistant_run_errors_cause_chain_check
    CHECK (cause_chain IS NULL OR jsonb_typeof(cause_chain) = 'array'),
  CONSTRAINT bst_assistant_run_errors_http_status_check
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT bst_assistant_run_errors_response_headers_check
    CHECK (response_headers IS NULL OR jsonb_typeof(response_headers) = 'object')
);

CREATE INDEX IF NOT EXISTS bst_assistant_run_errors_thread_idx
  ON ${ASSISTANT_RUN_ERRORS_TABLE} (thread_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS bst_assistant_run_errors_resource_idx
  ON ${ASSISTANT_RUN_ERRORS_TABLE} (resource_id, occurred_at DESC);

-- Durable per-thread token usage (Phase 5.1). model/provider are PER ROW so
-- cost is attributable per model when a thread switches models mid-run.
-- Bootstrapped here (alongside the runs table) AND created by migration 046 so
-- both the test-only numbered runner and the real app converge on one shape.
-- No FK to mastra_threads: usage may be recorded for non-memory-backed turns,
-- and the row is a billing fact that should outlive a thread deletion cascade.
-- root_id (Phase 5.2, nullable) groups usage by workspace ROOT for cross-root
-- cost aggregation. Captured at request start (focus can change mid-run);
-- NULL is an honest "unattributed" bucket, never a fake root. This bootstrap,
-- migration 046 (table), and migration 047 (ALTER + index) must converge on
-- one shape — keep the column + the root index byte-identical to 047.
CREATE TABLE IF NOT EXISTS ${ASSISTANT_RUN_USAGE_TABLE} (
  id text PRIMARY KEY,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  resource_id text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  billed_cost_usd numeric(24, 12) CHECK (billed_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  root_id text,
  cache_read_input_tokens integer CHECK (cache_read_input_tokens >= 0),
  cache_creation_input_tokens integer CHECK (cache_creation_input_tokens >= 0)
);

ALTER TABLE ${ASSISTANT_RUN_USAGE_TABLE}
  ADD COLUMN IF NOT EXISTS billed_cost_usd numeric(24, 12) CHECK (billed_cost_usd >= 0);

-- Anthropic prompt-cache token classes (BST-587): keep byte-identical to
-- migration 068. input_tokens remains the TOTAL the model saw.
ALTER TABLE ${ASSISTANT_RUN_USAGE_TABLE}
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens integer CHECK (cache_read_input_tokens >= 0);
ALTER TABLE ${ASSISTANT_RUN_USAGE_TABLE}
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens integer CHECK (cache_creation_input_tokens >= 0);

-- Run-kind attribution (BST-953/BST-1200): keep the accepted values aligned
-- with migration 090 while preserving the renderer bootstrap's add-only rule.
-- 'chat' = parent assistant turn; 'subagent' = persona delegation child;
-- 'compaction-summary' = pre-request auxiliary summarizer call;
-- 'om-observation'/'om-reflection' = observational-memory background cycles.
ALTER TABLE ${ASSISTANT_RUN_USAGE_TABLE}
  ADD COLUMN IF NOT EXISTS run_kind text NOT NULL DEFAULT 'chat'
  CHECK (run_kind IN ('chat', 'subagent', 'compaction-summary', 'om-observation', 'om-reflection'));

-- Desktop main migration 090 owns widening an existing pre-090 CHECK. This
-- renderer-reachable bootstrap may only install the final constraint when it
-- is absent; emitting DROP CONSTRAINT here is rejected by db:exec's
-- destructive-schema guard and prevents the assistant panel from mounting.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'brainstrike_assistant_run_usage_run_kind_check'
      AND conrelid = '${ASSISTANT_RUN_USAGE_TABLE}'::regclass
  ) THEN
    ALTER TABLE ${ASSISTANT_RUN_USAGE_TABLE}
      ADD CONSTRAINT brainstrike_assistant_run_usage_run_kind_check
      CHECK (run_kind IN ('chat', 'subagent', 'compaction-summary', 'om-observation', 'om-reflection'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_thread_idx
  ON ${ASSISTANT_RUN_USAGE_TABLE} (thread_id);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_root_idx
  ON ${ASSISTANT_RUN_USAGE_TABLE} (resource_id, root_id);

-- Per-turn edit checkpoint journal (undo of agent file edits). The renderer
-- reads this table directly (Path A, like run_events), so it is bootstrapped
-- here AND created by migration 051 — keep the shape byte-identical to 051.
-- NO FK to thread_runs/mastra_threads: the numbered migration runner (tests)
-- and drizzle path run on a bare PGlite without those parent tables, so an FK
-- REFERENCES would break the migration suite. Full BEFORE-content is stored
-- (capped/binary-refused via capture_status); after_hash/after_existed are for
-- conflict detection only. Factory reset purges the table (db-ipc clearAll).
CREATE TABLE IF NOT EXISTS ${ASSISTANT_EDIT_CHECKPOINTS_TABLE} (
  id             text PRIMARY KEY,
  run_id         text NOT NULL,
  resource_id    text NOT NULL,
  thread_id      text NOT NULL,
  tool_call_id   text,
  tool_name      text NOT NULL,
  op             text NOT NULL CHECK (op IN ('write','string_replace','delete','rename')),
  root_id        text NOT NULL,
  path           text NOT NULL,
  from_path      text,
  before_existed boolean NOT NULL,
  before_hash    text,
  before_content text,
  before_size    integer,
  after_hash     text,
  after_existed  boolean NOT NULL,
  capture_status text NOT NULL CHECK (capture_status IN
                   ('ok','created','skipped_binary','skipped_too_large','expired','rename')),
  reverted_at    timestamptz,
  occurred_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_thread_idx
  ON ${ASSISTANT_EDIT_CHECKPOINTS_TABLE} (thread_id, resource_id, occurred_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_run_idx
  ON ${ASSISTANT_EDIT_CHECKPOINTS_TABLE} (run_id, occurred_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_revert_idx
  ON ${ASSISTANT_EDIT_CHECKPOINTS_TABLE} (thread_id, reverted_at);

-- Per-run outcome labels (Task Ledger, Phase 1). At most one verdict per run
-- (upsert on run_id); 'source' preserves label provenance (user verdict,
-- edit-checkpoint revert derivation, or lifecycle-hook report). Bootstrapped
-- here AND created by migration 062 — keep the shape byte-identical to 062.
-- NO FK to thread_runs (migration runners execute on a bare PGlite without the
-- parent); like run_usage, outcome rows are analytic facts that outlive thread
-- deletion. Factory reset purges the table (db-ipc.ts OptionalRelationTable).
CREATE TABLE IF NOT EXISTS ${ASSISTANT_RUN_OUTCOMES_TABLE} (
  run_id      text PRIMARY KEY,
  thread_id   text NOT NULL,
  resource_id text NOT NULL,
  verdict     text NOT NULL CHECK (verdict IN ('succeeded','failed','mixed')),
  source      text NOT NULL CHECK (source IN ('user','edit_revert','hook')),
  detail      text,
  labeled_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_outcomes_thread_idx
  ON ${ASSISTANT_RUN_OUTCOMES_TABLE} (thread_id, resource_id);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_outcomes_resource_idx
  ON ${ASSISTANT_RUN_OUTCOMES_TABLE} (resource_id, labeled_at DESC);

-- Per-run experiment treatment record (BST-1250, recursive self-improvement
-- phase 2A). One row per hosted run, written by desktop main at prompt
-- assembly (injection_status 'continuation' for approval/resume legs, which
-- never reach it) — the ONE seam that knows whether self-improvement signal
-- injection actually happened and what exact text was injected
-- (signal_content_hash = SHA-256 of the injected system message). Without it
-- treatment could only be inferred from date windows or the CURRENT
-- preference value, both unsound. experiment_id/variant stay NULL for
-- un-enrolled runs. Bootstrapped here AND created by migration 093 — keep
-- the shape byte-identical to 093. NO FK (the numbered runner executes on a
-- bare PGlite without the run/thread parents); retained on thread delete
-- like run_outcomes (experiment evidence), cleared on factory reset via the
-- db reset registry.
CREATE TABLE IF NOT EXISTS ${ASSISTANT_RUN_TREATMENTS_TABLE} (
  run_id text PRIMARY KEY,
  thread_id text NOT NULL,
  resource_id text NOT NULL,
  experiment_id text,
  variant text,
  injection_status text NOT NULL CHECK (
    injection_status IN ('continuation', 'injected', 'no_waste', 'preference_malformed', 'preference_off', 'query_failed')
  ),
  signal_injected boolean NOT NULL,
  signal_content_hash text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT brainstrike_assistant_run_treatments_injected_consistency
    CHECK (signal_injected = (injection_status = 'injected'))
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_treatments_created_at_idx
  ON ${ASSISTANT_RUN_TREATMENTS_TABLE} (created_at);

-- Thread placements are Brainstrike presentation state (migrations 054+056).
-- Bootstrapped here because the thread-delete cascade now owns the placements
-- stage on EVERY path (BST-993) and this repository runs against a bare
-- PGlite in the migration-less harness — keep the shape byte-identical to
-- 054 with 056's flat_rank addition (056's color column is on GROUPS, not
-- placements — review #2167 caught the phantom column).
CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_placements (
  thread_id   text PRIMARY KEY,
  resource_id text NOT NULL,
  group_id    text,
  rank        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT NOW(),
  flat_rank   text
);

CREATE INDEX IF NOT EXISTS idx_assistant_thread_placements_resource_group
  ON brainstrike_assistant_thread_placements (resource_id, group_id);

-- Per-thread workspace snapshots (BST-1268, migration 094). Bootstrapped here
-- because the thread-delete cascade references every registered sidecar
-- unconditionally and this repository runs against a bare PGlite in the
-- migration-less harness — keep the shape byte-identical to 094.
CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_workspaces (
  thread_id   text PRIMARY KEY,
  resource_id text NOT NULL,
  payload     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);

-- Sync-the-mind op-log seam (BST-993). Bootstrapped here AND created by
-- migration 079 — keep the shape byte-identical to 079. Delete ops only;
-- widening the vocabulary is a conscious migration, never a drift channel.
CREATE TABLE IF NOT EXISTS ${MIND_OPS_TABLE} (
  seq BIGSERIAL PRIMARY KEY,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('thread', 'prompt_item')),
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op = 'delete'),
  resource_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brainstrike_mind_ops_entity_idx
  ON ${MIND_OPS_TABLE} (entity_kind, entity_id);
`;
}

const assistantThreadRepositoryCache = new WeakMap<DbHandle, BulkAssistantThreadRepository>();
const assistantThreadSchemaInitPromises = new WeakMap<DbHandle, Promise<void>>();
const ASSISTANT_THREAD_ICON_ID_SET = new Set<string>(ASSISTANT_THREAD_ICON_IDS);
const ASSISTANT_THREAD_COLOR_ID_SET = new Set<string>(ASSISTANT_THREAD_COLOR_IDS);
const ASSISTANT_THREAD_METADATA_KEYS = new Set<string>([
  'color',
  'icon',
  'model',
  'modelSettings',
  'operatingRootDisplayName',
  'operatingRootId',
  'operatingRootPath',
  'provider',
  'providerOptions',
  'secondaryRootIds',
  'source',
]);

function assertMemoryDatabase(database: DbHandle): asserts database is DbHandle & {
  exec: NonNullable<DbHandle['exec']>;
} {
  if (typeof database.exec !== 'function') {
    throw new Error('Assistant memory requires a database handle with exec support.');
  }
}

function createThreadId(): string {
  return `thread-${crypto.randomUUID()}`;
}

function resolveInitialThreadTitle(title: string | undefined): string {
  if (title === undefined) {
    return DEFAULT_THREAD_TITLE;
  }
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new Error('Thread title is required.');
  }
  return normalizedTitle;
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Invalid timestamp value');
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  throw new Error(`Invalid timestamp value: ${String(value)}`);
}

function normalizeNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeDate(value);
}

function toMemoryThread(thread: {
  createdAt: unknown;
  id: string;
  latestRun?: AssistantThreadRunRecord;
  metadata?: unknown;
  resourceId: string;
  title?: string | null;
  updatedAt: unknown;
}): AssistantMemoryThread {
  const metadata = sanitizeThreadMetadata(thread.metadata);
  return {
    createdAt: normalizeDate(thread.createdAt),
    id: thread.id,
    resourceId: thread.resourceId,
    title: thread.title?.trim() || DEFAULT_THREAD_TITLE,
    updatedAt: normalizeDate(thread.updatedAt),
    ...(thread.latestRun ? { latestRun: thread.latestRun } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Mastra memory row: ${fieldName} is not a string.`);
  }
  return value;
}

function requireNonEmptyTopologyId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Assistant message topology ${fieldName} must be a non-empty string.`);
  }
  return value;
}

function mapAssistantHistoryMessageRow(row: Record<string, unknown>): AssistantHistoryMessage {
  const parentMappingMessageId = row['parentMappingMessageId'];
  if (parentMappingMessageId !== null && parentMappingMessageId !== undefined) {
    requireNonEmptyTopologyId(parentMappingMessageId, 'parentMappingMessageId');
  }
  const parentId = row['parentId'];
  if (parentMappingMessageId !== null && parentMappingMessageId !== undefined) {
    if (parentId !== null) {
      requireNonEmptyTopologyId(parentId, 'parentId');
    }
  } else if (parentId !== null && parentId !== undefined) {
    throw new Error('Assistant message parent exists without a mapping row.');
  }
  return {
    content: parseJson(row['content']),
    createdAt: normalizeDate(row['createdAt']),
    id: requireString(row['id'], 'id'),
    ...(parentMappingMessageId === null || parentMappingMessageId === undefined
      ? {}
      : { parentId: parentId === null ? null : (parentId as string) }),
    role: requireString(row['role'], 'role'),
  };
}

/**
 * Validate a usage token count before persistence. Malformed values THROW —
 * there is no silent coercion to 0 (see AGENTS.md "no silent fallbacks").
 */
function assertUsageTokenCount(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Assistant run usage ${fieldName} must be a non-negative safe integer.`);
  }
}

/**
 * Coerce a SUM() aggregate (PGlite returns ::bigint as a string) into a
 * non-negative integer, throwing if the DB hands back something unparseable.
 */
function requireNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!(Number.isFinite(parsed) && Number.isInteger(parsed)) || parsed < 0) {
    throw new Error(`Invalid run usage aggregate: ${fieldName} is not a non-negative integer.`);
  }
  return parsed;
}

function optionalNonNegativeFiniteNumber(value: unknown, fieldName: string): number | undefined {
  if (value === null || value === undefined) {
    return;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid run usage aggregate: ${fieldName} is not a non-negative number.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  return optionalRecord(parsed);
}

function optionalThreadIconId(value: unknown): AssistantThreadIconId | undefined {
  return typeof value === 'string' && ASSISTANT_THREAD_ICON_ID_SET.has(value)
    ? (value as AssistantThreadIconId)
    : undefined;
}

function optionalThreadColorId(value: unknown): AssistantThreadColorId | undefined {
  return typeof value === 'string' && ASSISTANT_THREAD_COLOR_ID_SET.has(value)
    ? (value as AssistantThreadColorId)
    : undefined;
}

function optionalOperatingRootMetadataString(
  metadata: Record<string, unknown>,
  key: 'operatingRootDisplayName' | 'operatingRootId' | 'operatingRootPath',
  label: string
): string | undefined {
  if (!Object.hasOwn(metadata, key)) {
    return;
  }
  const value = optionalString(metadata[key]);
  if (!value) {
    throw new Error(`Invalid assistant thread metadata ${label}.`);
  }
  return value;
}

function optionalSecondaryRootIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistant thread metadata secondary root ids.');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    // Trim-empty matches `optionalString`'s semantics: a whitespace-only id is
    // no id at all, so it is rejected rather than silently persisted.
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('Invalid assistant thread metadata secondary root ids.');
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      ids.push(entry);
    }
  }
  return ids;
}

function assertOptionalThreadMetadataString(value: string | undefined, label: string): void {
  if (value !== undefined && !optionalString(value)) {
    throw new Error(`Invalid assistant thread metadata ${label}.`);
  }
}

function assertCompleteOperatingRootMetadata(metadata: {
  readonly operatingRootDisplayName?: string | undefined;
  readonly operatingRootId?: string | undefined;
  readonly operatingRootPath?: string | undefined;
}): void {
  const hasAnyOperatingRootMetadata = Boolean(
    metadata.operatingRootDisplayName || metadata.operatingRootId || metadata.operatingRootPath
  );
  if (
    hasAnyOperatingRootMetadata &&
    !(metadata.operatingRootDisplayName && metadata.operatingRootId)
  ) {
    throw new Error('Assistant thread operating-root metadata is incomplete.');
  }
}

function sanitizeThreadMetadata(value: unknown): AssistantThreadMetadata | undefined {
  if (!isRecord(value)) {
    return;
  }
  const metadata: MutableAssistantThreadMetadata = {};
  const icon = optionalThreadIconId(value['icon']);
  const color = optionalThreadColorId(value['color']);
  const provider = optionalString(value['provider']);
  const model = optionalString(value['model']);
  const modelSettings = optionalRecord(value['modelSettings']);
  const operatingRootDisplayName = optionalOperatingRootMetadataString(
    value,
    'operatingRootDisplayName',
    'operating root display name'
  );
  const operatingRootId = optionalOperatingRootMetadataString(
    value,
    'operatingRootId',
    'operating root id'
  );
  const operatingRootPath = optionalOperatingRootMetadataString(
    value,
    'operatingRootPath',
    'operating root path'
  );
  const providerOptions = optionalRecord(value['providerOptions']);
  const source = optionalString(value['source']);
  const secondaryRootIds = optionalSecondaryRootIds(value['secondaryRootIds']);
  assertCompleteOperatingRootMetadata({
    ...(operatingRootDisplayName ? { operatingRootDisplayName } : {}),
    ...(operatingRootId ? { operatingRootId } : {}),
    ...(operatingRootPath ? { operatingRootPath } : {}),
  });

  if (icon) {
    metadata.icon = icon;
  }
  if (color) {
    metadata.color = color;
  }
  if (provider) {
    metadata.provider = provider;
  }
  if (model) {
    metadata.model = model;
  }
  if (modelSettings) {
    metadata.modelSettings = modelSettings;
  }
  if (operatingRootDisplayName) {
    metadata.operatingRootDisplayName = operatingRootDisplayName;
  }
  if (operatingRootId) {
    metadata.operatingRootId = operatingRootId;
  }
  if (operatingRootPath) {
    metadata.operatingRootPath = operatingRootPath;
  }
  if (secondaryRootIds) {
    metadata.secondaryRootIds = secondaryRootIds;
  }
  if (providerOptions) {
    metadata.providerOptions = providerOptions;
  }
  if (source) {
    metadata.source = source;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function assertPersistableThreadMetadata(metadata: AssistantThreadMetadata): void {
  const metadataValue: unknown = metadata;
  if (!isRecord(metadataValue)) {
    throw new Error('Assistant thread metadata must be an object.');
  }
  for (const key of Object.keys(metadataValue)) {
    if (!ASSISTANT_THREAD_METADATA_KEYS.has(key)) {
      throw new Error(`Invalid assistant thread metadata key: ${key}.`);
    }
  }
  if (metadata.icon !== undefined && !ASSISTANT_THREAD_ICON_ID_SET.has(metadata.icon)) {
    throw new Error('Invalid assistant thread metadata icon.');
  }
  if (metadata.color !== undefined && !ASSISTANT_THREAD_COLOR_ID_SET.has(metadata.color)) {
    throw new Error('Invalid assistant thread metadata color.');
  }
  assertCompleteOperatingRootMetadata(metadata);
  assertOptionalThreadMetadataString(metadata.provider, 'provider');
  assertOptionalThreadMetadataString(metadata.model, 'model');
  assertOptionalThreadMetadataString(
    metadata.operatingRootDisplayName,
    'operating root display name'
  );
  assertOptionalThreadMetadataString(metadata.operatingRootId, 'operating root id');
  assertOptionalThreadMetadataString(metadata.operatingRootPath, 'operating root path');
  assertOptionalThreadMetadataString(metadata.source, 'source');
  optionalSecondaryRootIds(metadata.secondaryRootIds);
  if (metadata.modelSettings !== undefined && !optionalRecord(metadata.modelSettings)) {
    throw new Error('Invalid assistant thread metadata model settings.');
  }
  if (metadata.providerOptions !== undefined && !optionalRecord(metadata.providerOptions)) {
    throw new Error('Invalid assistant thread metadata provider options.');
  }
}

/**
 * Narrows metadata for persistence: `secondaryRootIds`, when present, is
 * replaced with its deduped form (see `optionalSecondaryRootIds`) so every
 * write path — single-thread or bulk — serializes the same normalized shape.
 * Callers must validate the metadata first (`assertPersistableThreadMetadata`
 * / `requireNonemptyThreadMetadata`); this does not re-validate.
 */
function normalizeThreadMetadataForPersistence(
  metadata: AssistantThreadMetadata
): AssistantThreadMetadata {
  const dedupedSecondaryRootIds = metadata.secondaryRootIds
    ? optionalSecondaryRootIds(metadata.secondaryRootIds)
    : undefined;
  return {
    ...metadata,
    ...(dedupedSecondaryRootIds ? { secondaryRootIds: dedupedSecondaryRootIds } : {}),
  };
}

function requireAssistantThreadIds(threadIds: readonly string[]): readonly string[] {
  if (!Array.isArray(threadIds) || threadIds.length === 0) {
    throw new Error('At least one assistant thread id is required.');
  }
  const seenIds = new Set<string>();
  for (const threadId of threadIds) {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new Error('Assistant thread id is required.');
    }
    if (seenIds.has(threadId)) {
      throw new Error(`Duplicate assistant thread id: ${threadId}.`);
    }
    seenIds.add(threadId);
  }
  return threadIds;
}

function requireNonemptyThreadMetadata(metadata: AssistantThreadMetadata): void {
  assertPersistableThreadMetadata(metadata);
  if (Object.keys(metadata).length === 0) {
    throw new Error('Assistant thread metadata must include at least one field.');
  }
}

function threadIdValuesSql(threadIds: readonly string[]): string {
  return threadIds.map((_, index) => `($${index + 1})`).join(', ');
}

function assertAllBulkThreadsFound(row: Record<string, unknown> | undefined): void {
  if (typeof row?.['allFound'] !== 'boolean') {
    throw new Error('Invalid assistant thread bulk mutation result.');
  }
  if (!row['allFound']) {
    throw new Error('One or more assistant threads do not exist.');
  }
}

function requireRunStatus(value: unknown): AssistantThreadRunStatus {
  if (value === 'cancelled' || value === 'completed' || value === 'failed' || value === 'running') {
    return value;
  }
  throw new Error('Invalid assistant thread run row: status is not valid.');
}

function requireRunUsageKind(value: unknown): AssistantRunUsageKind {
  if (
    typeof value === 'string' &&
    (ASSISTANT_RUN_USAGE_KINDS as readonly string[]).includes(value)
  ) {
    return value as AssistantRunUsageKind;
  }
  throw new Error('Invalid assistant run usage row: run_kind is not valid.');
}

function requireRuntimeKind(value: unknown): AssistantThreadRuntimeKind {
  if (value === 'browser' || value === 'gateway' || value === 'hosted' || value === 'local') {
    return value;
  }
  throw new Error('Invalid assistant thread run row: runtime_kind is not valid.');
}

function getRowValue(row: Record<string, unknown>, camelKey: string, snakeKey: string): unknown {
  return row[camelKey] ?? row[snakeKey];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Char cap for a rendered root display name (mirrors the SUBSTR in the SQL). */
const MAX_ROOT_DISPLAY_NAME_CHARS = 512;

function boundedNullableString(value: unknown, maxChars: number): string | null {
  const text = nullableString(value);
  if (text === null) {
    return text;
  }
  // Slice by code POINTS, not UTF-16 code units, so this actually mirrors the
  // SQL `SUBSTR(..., 1, N)` (which counts characters): a name ending in a
  // surrogate-pair grapheme (e.g. an emoji) at the boundary never leaves a lone
  // surrogate. `[...text]` iterates code points.
  const codePoints = [...text];
  return codePoints.length <= maxChars ? text : codePoints.slice(0, maxChars).join('');
}

const ASSISTANT_RUN_EVENT_KIND_SET = new Set<AssistantRunEventKind>(ASSISTANT_RUN_EVENT_KINDS);

const ASSISTANT_RUN_EVENT_STATUS_SET = new Set<AssistantRunEventStatus>(
  ASSISTANT_RUN_EVENT_STATUSES
);

function requireRunEventKind(value: unknown): AssistantRunEventKind {
  if (
    typeof value === 'string' &&
    ASSISTANT_RUN_EVENT_KIND_SET.has(value as AssistantRunEventKind)
  ) {
    return value as AssistantRunEventKind;
  }
  throw new Error('Invalid assistant run event row: kind is not valid.');
}

function requireRunEventStatus(value: unknown): AssistantRunEventStatus {
  if (
    typeof value === 'string' &&
    ASSISTANT_RUN_EVENT_STATUS_SET.has(value as AssistantRunEventStatus)
  ) {
    return value as AssistantRunEventStatus;
  }
  throw new Error('Invalid assistant run event row: status is not valid.');
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function toThreadRunEvent(row: Record<string, unknown>): AssistantRunEvent {
  const metadata = optionalJsonRecord(row['metadata']);
  const sanitizedMetadata = sanitizeAssistantRunEventMetadata(metadata);
  const detail = nullableString(row['detail']);
  const durationRaw = getRowValue(row, 'durationMs', 'duration_ms');
  const durationMs = isFiniteInteger(durationRaw) ? durationRaw : undefined;
  const event: AssistantRunEvent = {
    id: requireString(row['id'], 'id'),
    kind: requireRunEventKind(row['kind']),
    label: requireString(row['label'], 'label'),
    runId: requireString(getRowValue(row, 'runId', 'run_id'), 'runId'),
    sequence: isFiniteInteger(row['sequence']) ? row['sequence'] : Number(row['sequence']),
    status: requireRunEventStatus(row['status']),
    timestamp: normalizeDate(getRowValue(row, 'timestamp', 'occurred_at')).toISOString(),
    ...(detail ? { detail } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}),
  };
  if (!Number.isSafeInteger(event.sequence)) {
    throw new Error('Invalid assistant run event row: sequence is not valid.');
  }
  return event;
}

function requireCheckpointOp(value: unknown): AssistantEditCheckpointOp {
  if (
    typeof value === 'string' &&
    (ASSISTANT_EDIT_CHECKPOINT_OPS as readonly string[]).includes(value)
  ) {
    return value as AssistantEditCheckpointOp;
  }
  throw new Error(`Invalid edit checkpoint row: op "${String(value)}" is not valid.`);
}

function requireCheckpointCaptureStatus(value: unknown): AssistantEditCheckpointCaptureStatus {
  if (
    typeof value === 'string' &&
    (ASSISTANT_EDIT_CHECKPOINT_CAPTURE_STATUSES as readonly string[]).includes(value)
  ) {
    return value as AssistantEditCheckpointCaptureStatus;
  }
  throw new Error(`Invalid edit checkpoint row: capture_status "${String(value)}" is not valid.`);
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toEditCheckpointRecord(row: Record<string, unknown>): AssistantEditCheckpointRecord {
  const revertedAt = normalizeNullableDate(getRowValue(row, 'revertedAt', 'reverted_at'));
  return {
    afterExisted: Boolean(getRowValue(row, 'afterExisted', 'after_existed')),
    afterHash: nullableString(getRowValue(row, 'afterHash', 'after_hash')),
    beforeExisted: Boolean(getRowValue(row, 'beforeExisted', 'before_existed')),
    beforeHash: nullableString(getRowValue(row, 'beforeHash', 'before_hash')),
    beforeSize: nullableInteger(getRowValue(row, 'beforeSize', 'before_size')),
    captureStatus: requireCheckpointCaptureStatus(
      getRowValue(row, 'captureStatus', 'capture_status')
    ),
    fromPath: nullableString(getRowValue(row, 'fromPath', 'from_path')),
    id: requireString(row['id'], 'id'),
    occurredAt: normalizeDate(getRowValue(row, 'occurredAt', 'occurred_at')).toISOString(),
    op: requireCheckpointOp(row['op']),
    path: requireString(row['path'], 'path'),
    resourceId: requireString(getRowValue(row, 'resourceId', 'resource_id'), 'resourceId'),
    revertedAt: revertedAt ? revertedAt.toISOString() : null,
    rootId: requireString(getRowValue(row, 'rootId', 'root_id'), 'rootId'),
    runId: requireString(getRowValue(row, 'runId', 'run_id'), 'runId'),
    threadId: requireString(getRowValue(row, 'threadId', 'thread_id'), 'threadId'),
    toolCallId: nullableString(getRowValue(row, 'toolCallId', 'tool_call_id')),
    toolName: requireString(getRowValue(row, 'toolName', 'tool_name'), 'toolName'),
  };
}

function toThreadRunRecord(row: Record<string, unknown>): AssistantThreadRunRecord {
  const modelSettings = optionalJsonRecord(getRowValue(row, 'modelSettings', 'model_settings'));
  const providerOptions = optionalJsonRecord(
    getRowValue(row, 'providerOptions', 'provider_options')
  );

  return {
    completedAt: normalizeNullableDate(getRowValue(row, 'completedAt', 'completed_at')),
    createdAt: normalizeDate(getRowValue(row, 'createdAt', 'created_at')),
    error: nullableString(row['error']),
    id: requireString(row['id'], 'id'),
    model: requireString(row['model'], 'model'),
    provider: requireString(row['provider'], 'provider'),
    resourceId: requireString(getRowValue(row, 'resourceId', 'resource_id'), 'resourceId'),
    runtimeKind: requireRuntimeKind(getRowValue(row, 'runtimeKind', 'runtime_kind')),
    startedAt: normalizeDate(getRowValue(row, 'startedAt', 'started_at')),
    status: requireRunStatus(row['status']),
    threadId: requireString(getRowValue(row, 'threadId', 'thread_id'), 'threadId'),
    turnMessageId: nullableString(getRowValue(row, 'turnMessageId', 'turn_message_id')),
    updatedAt: normalizeDate(getRowValue(row, 'updatedAt', 'updated_at')),
    ...(modelSettings ? { modelSettings } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

function toLatestThreadRunRecord(
  threadRow: Record<string, unknown>
): AssistantThreadRunRecord | undefined {
  const id = threadRow['latestRunId'];
  if (id === null || id === undefined) {
    return;
  }
  return toThreadRunRecord({
    completedAt: threadRow['latestRunCompletedAt'],
    createdAt: threadRow['latestRunCreatedAt'],
    error: threadRow['latestRunError'],
    id,
    model: threadRow['latestRunModel'],
    modelSettings: threadRow['latestRunModelSettings'],
    provider: threadRow['latestRunProvider'],
    providerOptions: threadRow['latestRunProviderOptions'],
    resourceId: threadRow['latestRunResourceId'],
    runtimeKind: threadRow['latestRunRuntimeKind'],
    startedAt: threadRow['latestRunStartedAt'],
    status: threadRow['latestRunStatus'],
    threadId: threadRow['latestRunThreadId'],
    turnMessageId: threadRow['latestRunTurnMessageId'],
    updatedAt: threadRow['latestRunUpdatedAt'],
  });
}

function toRunEventDataParts(runEvents: readonly AssistantRunEvent[]): Array<{
  readonly data: AssistantRunEvent;
  readonly name: typeof ASSISTANT_RUN_EVENT_DATA_NAME;
  readonly type: 'data';
}> {
  return runEvents.map((event) => ({
    data: event,
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data' as const,
  }));
}

type AssistantHistoryLoadResult = Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>>;
type AssistantHistoryMessagePart =
  AssistantHistoryLoadResult['messages'][number]['message']['content'][number];
type AssistantHistoryTextPart = Extract<AssistantHistoryMessagePart, { type: 'text' }>;
type AssistantHistoryToolCallPart = Extract<AssistantHistoryMessagePart, { type: 'tool-call' }>;
type AssistantHistoryReasoningPart = Extract<AssistantHistoryMessagePart, { type: 'reasoning' }>;
type AssistantHydratedContentPart =
  | AssistantHistoryTextPart
  | AssistantHistoryToolCallPart
  | AssistantHistoryReasoningPart;
type AssistantHistoryRepositoryMessages = AssistantHistoryLoadResult['messages'];
type AssistantRunEventDataPart = ReturnType<typeof toRunEventDataParts>[number];
interface AssistantToolResultSnapshot {
  readonly isError?: boolean;
  readonly result?: unknown;
}

/**
 * A hydrated content part paired with the epoch-ms moment it was produced
 * (Mastra persists per-part `createdAt` numbers). The timestamp drives
 * run-event interleaving so a reloaded thread reads in live order.
 */
interface TimedHistoryContentPart {
  readonly at?: number;
  readonly part: AssistantHydratedContentPart;
}

function extractText(value: unknown, seenObjects = new WeakSet<object>()): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  if (seenObjects.has(value)) {
    return '';
  }
  seenObjects.add(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item, seenObjects))
      .filter(Boolean)
      .join('\n');
  }

  const record = value as Record<string, unknown>;
  const directText = record['text'];
  if (typeof directText === 'string') {
    return directText;
  }
  const content = record['content'];
  if (typeof content === 'string') {
    return content;
  }
  return extractText(content, seenObjects);
}

function readContentPartArray(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  const parts = record['parts'];
  if (Array.isArray(parts)) {
    return parts;
  }
  const content = record['content'];
  return Array.isArray(content) ? content : undefined;
}

function stringifyArgsText(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

function toHistoryToolCallPart(
  record: Record<string, unknown>,
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>
): AssistantHistoryToolCallPart | undefined {
  const toolCallId = record['toolCallId'];
  const toolName = record['toolName'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return;
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return;
  }
  const args = (
    record['args'] && typeof record['args'] === 'object' && !Array.isArray(record['args'])
      ? record['args']
      : {}
  ) as AssistantHistoryToolCallPart['args'];
  const argsText =
    typeof record['argsText'] === 'string' ? record['argsText'] : stringifyArgsText(args);
  const persistedResult = toolResultsByCallId.get(toolCallId);
  const hasInlineResult = Object.hasOwn(record, 'result');
  const isError =
    typeof record['isError'] === 'boolean'
      ? record['isError']
      : isPersistedGuardedToolError(record['result'])
        ? true
        : persistedResult?.isError;
  return {
    args,
    argsText,
    toolCallId,
    // Persisted native tool ids are sanitized (`brainstrike_grepSearch`); render
    // the dotted form so a reloaded card matches the live label (D3).
    toolName: denormalizeNativeToolName(toolName),
    type: 'tool-call',
    ...(hasInlineResult ? { result: record['result'] } : {}),
    ...(hasInlineResult || !persistedResult || !Object.hasOwn(persistedResult, 'result')
      ? {}
      : { result: persistedResult.result }),
    ...(isError === undefined ? {} : { isError }),
  };
}

function toTextHistoryContentParts(value: unknown): AssistantHistoryTextPart[] {
  const text = extractText(value).trim();
  return text ? [{ text, type: 'text' }] : [];
}

function toHistoryReasoningPart(
  record: Record<string, unknown>
): AssistantHistoryReasoningPart | undefined {
  const reasoningText =
    typeof record['text'] === 'string'
      ? record['text']
      : typeof record['reasoning'] === 'string'
        ? record['reasoning']
        : '';
  const trimmed = reasoningText.trim();
  return trimmed ? { text: trimmed, type: 'reasoning' } : undefined;
}

/**
 * Mastra v2 (`MastraMessageContentV2`) persists tool calls as
 * `{ type: 'tool-invocation', toolInvocation: { toolCallId, toolName, args,
 * state, result } }` parts with the result INLINE — there are no separate
 * `role: 'tool'` rows in this dialect (see the live-loop proof in
 * packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts).
 */
function toHistoryToolCallPartFromInvocation(
  record: Record<string, unknown>
): AssistantHistoryToolCallPart | undefined {
  const invocation = record['toolInvocation'];
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) {
    return;
  }
  const inv = invocation as Record<string, unknown>;
  const state = typeof inv['state'] === 'string' ? inv['state'] : undefined;
  if (state === 'partial-call') {
    // Streaming-intermediate state; Mastra filters these before persisting,
    // so a stray one carries no renderable information.
    return;
  }
  const toolCallId = inv['toolCallId'];
  const toolName = inv['toolName'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return;
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return;
  }
  const args = (
    inv['args'] && typeof inv['args'] === 'object' && !Array.isArray(inv['args']) ? inv['args'] : {}
  ) as AssistantHistoryToolCallPart['args'];
  const hasResult = Object.hasOwn(inv, 'result');
  const errorText = typeof inv['errorText'] === 'string' ? inv['errorText'] : undefined;
  const isError =
    state === 'output-error' ||
    inv['isError'] === true ||
    isPersistedGuardedToolError(inv['result']);
  return {
    args,
    argsText: stringifyArgsText(args),
    toolCallId,
    // Persisted native tool ids are sanitized (`brainstrike_grepSearch`); render
    // the dotted form so a reloaded card matches the live label (D3).
    toolName: denormalizeNativeToolName(toolName),
    type: 'tool-call',
    ...(hasResult
      ? { result: inv['result'] }
      : errorText === undefined
        ? {}
        : { result: errorText }),
    ...(isError ? { isError: true } : {}),
  };
}

function isPersistedGuardedToolError(value: unknown): boolean {
  return isGuardedToolError(value);
}

/**
 * Observational-memory sealing persists progressive snapshots of the same
 * accumulating assistant message under fresh row ids, so one logical tool call
 * can appear in several assistant rows. Hydration keeps the FIRST occurrence
 * (preserving execution order) and merges richer fields (result, error flag)
 * from later duplicates into it.
 */
function dedupeHistoryToolCallPart(
  part: AssistantHistoryToolCallPart,
  seenToolCallsById: Map<string, AssistantHistoryToolCallPart>
): AssistantHistoryToolCallPart | undefined {
  const existing = seenToolCallsById.get(part.toolCallId);
  if (!existing) {
    seenToolCallsById.set(part.toolCallId, part);
    return part;
  }
  const mutable = existing as { result?: unknown; isError?: boolean };
  if (!Object.hasOwn(existing, 'result') && Object.hasOwn(part, 'result')) {
    mutable.result = (part as { result?: unknown }).result;
  }
  if (existing.isError === undefined && part.isError !== undefined) {
    mutable.isError = part.isError;
  }
  return;
}

function resolveRawContentPart(
  record: Record<string, unknown>,
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>
): AssistantHydratedContentPart | undefined {
  if (record['type'] === 'text' && typeof record['text'] === 'string') {
    const text = record['text'].trim();
    return text ? { text, type: 'text' } : undefined;
  }
  if (record['type'] === 'tool-call') {
    return toHistoryToolCallPart(record, toolResultsByCallId);
  }
  if (record['type'] === 'tool-invocation') {
    return toHistoryToolCallPartFromInvocation(record);
  }
  if (record['type'] === 'reasoning') {
    return toHistoryReasoningPart(record);
  }
  return;
}

function readPartCreatedAtMs(record: Record<string, unknown>): number | undefined {
  const value = record['createdAt'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toAssistantHistoryContentParts(
  value: unknown,
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>,
  seenToolCallsById?: Map<string, AssistantHistoryToolCallPart>
): TimedHistoryContentPart[] {
  const rawParts = readContentPartArray(value);
  if (!rawParts) {
    return toTextHistoryContentParts(value).map((part) => ({ part }));
  }

  const parts: TimedHistoryContentPart[] = [];
  for (const rawPart of rawParts) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      continue;
    }
    const record = rawPart as Record<string, unknown>;
    let resolved = resolveRawContentPart(record, toolResultsByCallId);
    if (resolved?.type === 'tool-call' && seenToolCallsById) {
      resolved = dedupeHistoryToolCallPart(resolved, seenToolCallsById);
    }
    if (resolved) {
      const at = readPartCreatedAtMs(record);
      parts.push(at === undefined ? { part: resolved } : { at, part: resolved });
    }
  }
  return parts;
}

function toToolResultSnapshot(record: Record<string, unknown>): {
  readonly snapshot: AssistantToolResultSnapshot;
  readonly toolCallId: string;
} | null {
  const toolCallId = record['toolCallId'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return null;
  }
  const hasResult = Object.hasOwn(record, 'result');
  const hasOutput = Object.hasOwn(record, 'output');
  const hasError = Object.hasOwn(record, 'error');
  if (!(hasResult || hasOutput || hasError || typeof record['isError'] === 'boolean')) {
    return null;
  }
  return {
    snapshot: {
      ...(hasResult
        ? { result: record['result'] }
        : hasOutput
          ? { result: record['output'] }
          : hasError
            ? { result: record['error'] }
            : {}),
      ...(typeof record['isError'] === 'boolean'
        ? { isError: record['isError'] }
        : hasError
          ? { isError: true }
          : {}),
    },
    toolCallId,
  };
}

function readToolResultParts(value: unknown): readonly unknown[] {
  const rawParts = readContentPartArray(value);
  if (rawParts) {
    return rawParts;
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
}

function collectToolResults(
  messages: readonly AssistantHistoryMessage[]
): ReadonlyMap<string, AssistantToolResultSnapshot> {
  const results = new Map<string, AssistantToolResultSnapshot>();
  for (const message of messages) {
    if (message.role !== 'tool') {
      continue;
    }
    for (const rawPart of readToolResultParts(message.content)) {
      if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
        continue;
      }
      const record = rawPart as Record<string, unknown>;
      if (record['type'] !== undefined && record['type'] !== 'tool-result') {
        continue;
      }
      const toolResult = toToolResultSnapshot(record);
      if (toolResult) {
        results.set(toolResult.toolCallId, toolResult.snapshot);
      }
    }
  }
  return results;
}

/**
 * A run of assistant snapshot rows for one branch identity. User/system rows
 * and a new topology-bearing assistant ID split groups; legacy `role: 'tool'`
 * rows do not. Observational-memory sealing and per-step saves split ONE live
 * assistant turn into several rows, so a group hydrates back into a single
 * assistant-ui message — matching what the thread looked like while it streamed.
 */
interface AssistantHistoryRowGroup {
  readonly kind: 'assistant-group';
  readonly parts: TimedHistoryContentPart[];
  readonly rows: AssistantHistoryMessage[];
}

interface AssistantHistorySingleUnit {
  readonly kind: 'user' | 'system';
  readonly message: AssistantHistoryMessage;
}

type AssistantHistoryUnit = AssistantHistoryRowGroup | AssistantHistorySingleUnit;

function runEventTimeMs(eventPart: AssistantRunEventDataPart): number {
  const ms = Date.parse(eventPart.data.timestamp);
  // Unparseable timestamps surface at the front of the group (the legacy
  // prepend position) instead of being dropped.
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Tool-invocation parts rarely carry their own persisted timestamp, but every
 * tool execution emits a `tool.started` run event whose metadata names the
 * toolCallId — re-time each tool-call part to its own start event so reloaded
 * calls sit exactly where they executed instead of clumping at a snapshot
 * boundary.
 */
function applyToolEventTimes(
  parts: readonly TimedHistoryContentPart[],
  eventParts: readonly AssistantRunEventDataPart[]
): readonly TimedHistoryContentPart[] {
  const startTimesByToolCallId = new Map<string, number>();
  for (const eventPart of eventParts) {
    if (eventPart.data.kind !== 'tool.started') {
      continue;
    }
    const toolCallId = eventPart.data.metadata?.['toolCallId'];
    if (typeof toolCallId !== 'string' || startTimesByToolCallId.has(toolCallId)) {
      continue;
    }
    const ms = Date.parse(eventPart.data.timestamp);
    if (!Number.isNaN(ms)) {
      startTimesByToolCallId.set(toolCallId, ms);
    }
  }
  if (startTimesByToolCallId.size === 0) {
    return parts;
  }
  return parts.map((timed) => {
    if (timed.part.type !== 'tool-call') {
      return timed;
    }
    const ms = startTimesByToolCallId.get(timed.part.toolCallId);
    return ms === undefined ? timed : { at: ms, part: timed.part };
  });
}

/**
 * Interleave run events with content parts in live order: each event is
 * emitted before the first content part produced after it. Parts without a
 * persisted timestamp inherit the previous part's moment, so relative content
 * order is never changed.
 */
function weaveRunEventsIntoContent(
  parts: readonly TimedHistoryContentPart[],
  eventParts: readonly AssistantRunEventDataPart[],
  groupStartMs: number
): Array<AssistantHydratedContentPart | AssistantRunEventDataPart> {
  if (eventParts.length === 0) {
    return parts.map((timed) => timed.part);
  }
  const woven: Array<AssistantHydratedContentPart | AssistantRunEventDataPart> = [];
  let eventIndex = 0;
  let lastAt = groupStartMs;
  for (const timed of parts) {
    const at = timed.at ?? lastAt;
    lastAt = at;
    while (eventIndex < eventParts.length) {
      const eventPart = eventParts[eventIndex];
      if (!eventPart || runEventTimeMs(eventPart) > at) {
        break;
      }
      woven.push(eventPart);
      eventIndex += 1;
    }
    woven.push(timed.part);
  }
  for (; eventIndex < eventParts.length; eventIndex += 1) {
    const eventPart = eventParts[eventIndex];
    if (eventPart) {
      woven.push(eventPart);
    }
  }
  return woven;
}

/** Preserve Mastra v2 `content.metadata.custom` across renderer hydration. */
function readHistoryCustomMetadata(content: unknown): Record<string, unknown> {
  if (!isRecord(content)) {
    return {};
  }
  const metadata = content['metadata'];
  if (!isRecord(metadata)) {
    return {};
  }
  const custom = metadata['custom'];
  return isRecord(custom) ? { ...custom } : {};
}

function appendAssistantGroupMessage(args: {
  group: AssistantHistoryRowGroup;
  groupEventParts: readonly AssistantRunEventDataPart[];
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): string | null {
  const firstRow = args.group.rows.at(0);
  const lastRow = args.group.rows.at(-1);
  if (!(firstRow && lastRow)) {
    return null;
  }
  // A group with no renderable parts of its own is still appended when it
  // carries run events — otherwise the persisted execution path would be
  // invisible after reload.
  if (args.group.parts.length === 0 && args.groupEventParts.length === 0) {
    return null;
  }
  const content = weaveRunEventsIntoContent(
    applyToolEventTimes(args.group.parts, args.groupEventParts),
    args.groupEventParts,
    firstRow.createdAt.getTime()
  );
  const topologyRows = args.group.rows.filter((row) => row.parentId !== undefined);
  const messageId = topologyRows.at(0)?.id ?? lastRow.id;
  if (topologyRows.some((row) => row.id !== messageId)) {
    throw new Error(`Assistant message snapshots disagree on branch identity for ${lastRow.id}.`);
  }
  args.repositoryMessages.push({
    message: {
      content,
      createdAt: firstRow.createdAt,
      id: messageId,
      metadata: {
        custom: readHistoryCustomMetadata(lastRow.content),
        steps: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_annotations: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_data: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_state: null,
      },
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    },
    parentId: args.parentId,
  });
  return messageId;
}

function resolveAssistantGroupParentId(
  group: AssistantHistoryRowGroup,
  legacyParentId: string | null
): string | null {
  let resolvedParentId: string | null | undefined;
  for (const row of group.rows) {
    if (row.parentId === undefined) {
      continue;
    }
    if (resolvedParentId === undefined) {
      resolvedParentId = row.parentId;
      continue;
    }
    if (resolvedParentId !== row.parentId) {
      throw new Error(`Assistant message snapshots disagree on branch parent for ${row.id}.`);
    }
  }
  return resolvedParentId === undefined ? legacyParentId : resolvedParentId;
}

type AssistantHistoryUserMessage = Extract<
  AssistantHistoryRepositoryMessages[number]['message'],
  { role: 'user' }
>;
type AssistantHistoryUserAttachment = AssistantHistoryUserMessage['attachments'][number];

/**
 * Rebuild composer image attachments from the persisted Mastra v2 FILE
 * dialect: `{ type: 'file', data: <base64 data URL>, mimeType: 'image/…' }`
 * parts (the shape pinned by the packages/agent persistence spec — note
 * `mimeType`, not `mediaType`). Hydrated attachments render through the same
 * `MessagePrimitive.Attachments` strip as live sends, and their content is
 * re-merged into the outbound message on later turns so the model keeps
 * seeing the image after a reload.
 */
function toUserHistoryAttachments(
  messageId: string,
  value: unknown
): AssistantHistoryUserAttachment[] {
  const rawParts = readContentPartArray(value);
  if (!rawParts) {
    return [];
  }
  const attachments: AssistantHistoryUserAttachment[] = [];
  for (const raw of rawParts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (record['type'] !== 'file') {
      continue;
    }
    const data = record['data'];
    const mimeType = record['mimeType'];
    if (typeof data !== 'string' || typeof mimeType !== 'string') {
      continue;
    }
    // v1 attachments are images only; a non-image file part is not renderable
    // attachment state (and never produced by the composer adapter).
    const normalizedMimeType = mimeType.toLowerCase();
    if (!normalizedMimeType.startsWith('image/')) {
      continue;
    }
    const index = attachments.length + 1;
    const subtype = normalizedMimeType.slice('image/'.length) || 'png';
    attachments.push({
      content: [{ image: data, type: 'image' }],
      contentType: mimeType,
      id: `${messageId}-attachment-${index}`,
      name: `image-${index}.${subtype}`,
      status: { type: 'complete' },
      type: 'image',
    });
  }
  return attachments;
}

function appendUserHistoryMessage(args: {
  message: AssistantHistoryMessage;
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): boolean {
  const content = toTextHistoryContentParts(args.message.content);
  const attachments = toUserHistoryAttachments(args.message.id, args.message.content);
  // An image-only user message has no text part but must survive hydration.
  if (content.length === 0 && attachments.length === 0) {
    return false;
  }

  args.repositoryMessages.push({
    message: {
      attachments,
      content,
      createdAt: args.message.createdAt,
      id: args.message.id,
      metadata: { custom: {} },
      role: 'user',
    },
    parentId: args.parentId,
  });
  return true;
}

function appendSystemHistoryMessage(args: {
  message: AssistantHistoryMessage;
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): boolean {
  const textPart = toTextHistoryContentParts(args.message.content).at(0);
  if (!textPart) {
    return false;
  }

  args.repositoryMessages.push({
    message: {
      content: [textPart],
      createdAt: args.message.createdAt,
      id: args.message.id,
      metadata: { custom: {} },
      role: 'system',
    },
    parentId: args.parentId,
  });
  return true;
}

/**
 * Partition the row stream into units: user/system rows stand alone;
 * assistant snapshot rows with one topology identity collapse into one group
 * (legacy `role: 'tool'` rows neither render nor break a group). A second
 * topology-bearing assistant ID starts a regenerated sibling group even when
 * no user row separates the persisted responses. Conversion happens here
 * exactly once per row, in chronological order — the tool-call dedupe map is
 * stateful (it keeps the FIRST occurrence of each toolCallId across snapshot
 * rows), so re-converting a row would corrupt it.
 */
function buildHistoryUnits(
  messages: readonly AssistantHistoryMessage[],
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>
): AssistantHistoryUnit[] {
  const units: AssistantHistoryUnit[] = [];
  const seenToolCallsById = new Map<string, AssistantHistoryToolCallPart>();
  let openGroup: {
    parts: TimedHistoryContentPart[];
    rows: AssistantHistoryMessage[];
    topologyMessageId?: string;
  } | null = null;

  const closeOpenGroup = (): void => {
    if (!openGroup) {
      return;
    }
    units.push({ kind: 'assistant-group', parts: openGroup.parts, rows: openGroup.rows });
    openGroup = null;
  };

  for (const message of messages) {
    if (message.role === 'assistant') {
      const topologyMessageId = message.parentId === undefined ? undefined : message.id;
      if (
        topologyMessageId !== undefined &&
        openGroup !== null &&
        openGroup.topologyMessageId !== topologyMessageId
      ) {
        closeOpenGroup();
      }
      openGroup ??= { parts: [], rows: [] };
      if (topologyMessageId !== undefined) {
        openGroup.topologyMessageId = topologyMessageId;
      }
      openGroup.rows.push(message);
      // Parts without a persisted timestamp anchor to their snapshot row's
      // save time — each row seals shortly after its parts were produced.
      const rowMs = message.createdAt.getTime();
      openGroup.parts.push(
        ...toAssistantHistoryContentParts(
          message.content,
          toolResultsByCallId,
          seenToolCallsById
        ).map((timed) => (timed.at === undefined ? { at: rowMs, part: timed.part } : timed))
      );
      continue;
    }
    if (message.role === 'user' || message.role === 'system') {
      closeOpenGroup();
      units.push({ kind: message.role, message });
    }
    // Other roles (legacy 'tool' rows) are folded into tool results and never
    // rendered — they intentionally do not split an assistant group.
  }
  closeOpenGroup();
  return units;
}

/**
 * Assign each persisted run back to its own assistant group. A run's earliest
 * events occur before its first assistant row is saved, while the next run's
 * events form the upper boundary. Choosing the newest unassigned group inside
 * each run window preserves older turns and also avoids attaching a current
 * run's early memory/tool events to the previous turn.
 */
function assignRunEventsToGroups(
  units: readonly AssistantHistoryUnit[],
  runEvents: readonly AssistantRunEvent[]
): Map<AssistantHistoryUnit, AssistantRunEventDataPart[]> {
  const assignments = new Map<AssistantHistoryUnit, AssistantRunEventDataPart[]>();
  const assistantGroups = units.filter(
    (unit): unit is AssistantHistoryRowGroup => unit.kind === 'assistant-group'
  );
  if (assistantGroups.length === 0 || runEvents.length === 0) {
    return assignments;
  }

  const eventsByRunId = new Map<string, AssistantRunEvent[]>();
  for (const event of runEvents) {
    const runId = event.runId;
    if (!runId) {
      continue;
    }
    const runEventsForId = eventsByRunId.get(runId);
    if (runEventsForId) {
      runEventsForId.push(event);
    } else {
      eventsByRunId.set(runId, [event]);
    }
  }
  const runs = [...eventsByRunId.values()]
    .map((events) => ({
      events: events.sort(
        (left, right) =>
          (left.sequence ?? 0) - (right.sequence ?? 0) ||
          Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
          left.id.localeCompare(right.id)
      ),
      startedAt: Math.min(...events.map((event) => Date.parse(event.timestamp))),
    }))
    .filter((run) => Number.isFinite(run.startedAt))
    .sort((left, right) => left.startedAt - right.startedAt);
  const unassignedGroups = new Set(assistantGroups);

  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    if (!run) {
      continue;
    }
    const nextRunStartedAt = runs[runIndex + 1]?.startedAt ?? Number.POSITIVE_INFINITY;
    const candidate = assistantGroups.findLast((group) => {
      const firstRow = group.rows.at(0);
      return (
        unassignedGroups.has(group) &&
        firstRow !== undefined &&
        firstRow.createdAt.getTime() < nextRunStartedAt
      );
    });
    if (!candidate) {
      continue;
    }
    assignments.set(candidate, toRunEventDataParts(run.events));
    unassignedGroups.delete(candidate);
  }
  return assignments;
}

function historyMessagePartTimeRange(content: unknown): { first: number; last: number } | null {
  const parts = readContentPartArray(content);
  if (!parts) {
    return null;
  }
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const createdAt = (part as Record<string, unknown>)['createdAt'];
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
      continue;
    }
    first = Math.min(first, createdAt);
    last = Math.max(last, createdAt);
  }
  return Number.isFinite(first) && Number.isFinite(last) ? { first, last } : null;
}

const HISTORY_ROLE_ORDER: Readonly<Record<string, number>> = {
  assistant: 2,
  system: 0,
  tool: 3,
  user: 1,
};

function compareHistoryMessages(left: AssistantHistoryMessage, right: AssistantHistoryMessage) {
  const rowTimeDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (rowTimeDifference !== 0) {
    return rowTimeDifference;
  }
  const leftRange = historyMessagePartTimeRange(left.content);
  const rightRange = historyMessagePartTimeRange(right.content);
  const firstPartDifference = (leftRange?.first ?? 0) - (rightRange?.first ?? 0);
  if (firstPartDifference !== 0) {
    return firstPartDifference;
  }
  const lastPartDifference = (leftRange?.last ?? 0) - (rightRange?.last ?? 0);
  if (lastPartDifference !== 0) {
    return lastPartDifference;
  }
  const roleDifference =
    (HISTORY_ROLE_ORDER[left.role] ?? Number.MAX_SAFE_INTEGER) -
    (HISTORY_ROLE_ORDER[right.role] ?? Number.MAX_SAFE_INTEGER);
  return roleDifference === 0 ? left.id.localeCompare(right.id) : roleDifference;
}

/**
 * assistant-ui imports parents before children. Mastra updates `createdAt` when
 * a regeneration reuses its user message ID, so persisted chronological order
 * is not necessarily topological. Close the bounded graph, then perform a
 * stable parent-first traversal without adding a database round trip.
 */
function orderHistoryGraphForImport(
  repositoryMessages: AssistantHistoryRepositoryMessages
): AssistantHistoryRepositoryMessages {
  const messageById = new Map<string, AssistantHistoryRepositoryMessages[number]>();
  for (const item of repositoryMessages) {
    if (messageById.has(item.message.id)) {
      throw new Error(`Assistant history contains duplicate message ID ${item.message.id}.`);
    }
    messageById.set(item.message.id, item);
  }

  const closedMessages = repositoryMessages.map((item) =>
    item.parentId !== null && !messageById.has(item.parentId) ? { ...item, parentId: null } : item
  );
  const closedMessageById = new Map(closedMessages.map((item) => [item.message.id, item]));
  const visitState = new Map<string, 'visited' | 'visiting'>();
  const orderedMessages: AssistantHistoryRepositoryMessages = [];

  const visit = (item: AssistantHistoryRepositoryMessages[number]): void => {
    const messageId = item.message.id;
    const state = visitState.get(messageId);
    if (state === 'visited') {
      return;
    }
    if (state === 'visiting') {
      throw new Error(`Assistant history contains a parent cycle at message ${messageId}.`);
    }
    visitState.set(messageId, 'visiting');
    if (item.parentId !== null) {
      const parent = closedMessageById.get(item.parentId);
      if (!parent) {
        throw new Error(`Assistant history parent ${item.parentId} disappeared while ordering.`);
      }
      visit(parent);
    }
    visitState.set(messageId, 'visited');
    orderedMessages.push(item);
  };

  for (const item of closedMessages) {
    visit(item);
  }
  return orderedMessages;
}

function toHistoryRepository(
  messages: readonly AssistantHistoryMessage[],
  runEvents: readonly AssistantRunEvent[] = []
): Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>> {
  const repositoryMessages: Awaited<
    ReturnType<AssistantUiThreadHistoryAdapter['load']>
  >['messages'] = [];
  let parentId: string | null = null;
  const toolResultsByCallId = collectToolResults(messages);
  const orderedMessages = [...messages].sort(compareHistoryMessages);
  const units = buildHistoryUnits(orderedMessages, toolResultsByCallId);
  const runEventAssignments = assignRunEventsToGroups(units, runEvents);

  for (const unit of units) {
    if (unit.kind === 'assistant-group') {
      const appendedId = appendAssistantGroupMessage({
        group: unit,
        groupEventParts: runEventAssignments.get(unit) ?? [],
        parentId: resolveAssistantGroupParentId(unit, parentId),
        repositoryMessages,
      });
      if (appendedId !== null) {
        parentId = appendedId;
      }
      continue;
    }
    const appended =
      unit.kind === 'user'
        ? appendUserHistoryMessage({
            message: unit.message,
            parentId: unit.message.parentId === undefined ? parentId : unit.message.parentId,
            repositoryMessages,
          })
        : appendSystemHistoryMessage({
            message: unit.message,
            parentId: unit.message.parentId === undefined ? parentId : unit.message.parentId,
            repositoryMessages,
          });
    if (appended) {
      parentId = unit.message.id;
    }
  }

  const headId = repositoryMessages.at(-1)?.message.id ?? null;

  return {
    headId,
    messages: orderHistoryGraphForImport(repositoryMessages),
  };
}

/**
 * Synthetic rediscovered-pause message id prefixes. These ids exist only in
 * the hydrated UI thread (never as Mastra rows), so the topology adapter must
 * treat them as transient parents (BST-1243) — keep the prefix list and the
 * id construction in `appendSuspendedPauseMessages` in lockstep.
 */
const SUSPENDED_PAUSE_MESSAGE_ID_PREFIXES = ['suspended-approval', 'suspended-pause'] as const;
type SuspendedPauseMessageIdPrefix = (typeof SUSPENDED_PAUSE_MESSAGE_ID_PREFIXES)[number];

function isSuspendedPauseMessageId(messageId: string): boolean {
  return SUSPENDED_PAUSE_MESSAGE_ID_PREFIXES.some((prefix) => messageId.startsWith(`${prefix}:`));
}

interface RediscoveredPauseMessageSource {
  readonly data: RediscoveredToolApproval | RediscoveredToolSuspend;
  readonly dataName: typeof TOOL_APPROVAL_DATA_NAME | typeof TOOL_SUSPEND_DATA_NAME;
  readonly idPrefix: SuspendedPauseMessageIdPrefix;
  readonly runId: string;
  readonly suspendedAt: string;
  readonly toolCallId: string;
}

/**
 * Append one synthetic trailing assistant message per rediscovered pause —
 * suspended APPROVALS (`TOOL_APPROVAL_DATA_NAME`) and, since BST-1084,
 * suspend() PAUSES (`TOOL_SUSPEND_DATA_NAME`) — each carrying a single data
 * part identical to the live-stream mapper's output, so the existing notices
 * render and their Approve/Decline / typed-resume actions reuse the
 * (restart-safe, stateless) resume seams unchanged. Ordered oldest-first (by
 * `suspendedAt`, both kinds interleaved) and chained onto the current head so
 * the notices sit at the bottom of the thread. `toHistoryRepository` stays
 * untouched (its many existing tests keep passing).
 */
function appendSuspendedPauseMessages(
  result: AssistantHistoryLoadResult,
  approvals: readonly RediscoveredToolApproval[],
  suspends: readonly RediscoveredToolSuspend[]
): AssistantHistoryLoadResult {
  if (approvals.length === 0 && suspends.length === 0) {
    return result;
  }
  const sources: RediscoveredPauseMessageSource[] = [
    ...approvals.map(
      (approval): RediscoveredPauseMessageSource => ({
        data: approval,
        dataName: TOOL_APPROVAL_DATA_NAME,
        idPrefix: 'suspended-approval',
        runId: approval.runId,
        suspendedAt: approval.suspendedAt,
        toolCallId: approval.toolCallId,
      })
    ),
    ...suspends.map(
      (pause): RediscoveredPauseMessageSource => ({
        data: pause,
        dataName: TOOL_SUSPEND_DATA_NAME,
        idPrefix: 'suspended-pause',
        runId: pause.runId,
        suspendedAt: pause.suspendedAt,
        toolCallId: pause.toolCallId,
      })
    ),
  ].sort((a, b) => Date.parse(a.suspendedAt) - Date.parse(b.suspendedAt));

  const messages: AssistantHistoryRepositoryMessages = [...result.messages];
  let parentId: string | null = result.headId ?? null;
  let headId: string | null = result.headId ?? null;
  for (const source of sources) {
    const id = `${source.idPrefix}:${source.runId}:${source.toolCallId}`;
    messages.push({
      message: {
        content: [{ data: source.data, name: source.dataName, type: 'data' }],
        createdAt: new Date(source.suspendedAt),
        id,
        metadata: {
          custom: {},
          steps: [],
          // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
          unstable_annotations: [],
          // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
          unstable_data: [],
          // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
          unstable_state: null,
        },
        role: 'assistant',
        status: { reason: 'stop', type: 'complete' },
      },
      parentId,
    });
    parentId = id;
    headId = id;
  }
  return { headId, messages };
}

export function createPgliteAssistantThreadRepository(
  database: DbHandle
): BulkAssistantThreadRepository {
  assertMemoryDatabase(database);
  const cachedRepository = assistantThreadRepositoryCache.get(database);
  if (cachedRepository) {
    return cachedRepository;
  }
  const initialize = async (): Promise<void> => {
    let initPromise = assistantThreadSchemaInitPromises.get(database);
    if (!initPromise) {
      initPromise = database
        .exec(buildAssistantThreadRunsSchemaSql())
        .then(() => undefined)
        .catch((error: unknown) => {
          assistantThreadSchemaInitPromises.delete(database);
          throw error;
        });
      assistantThreadSchemaInitPromises.set(database, initPromise);
    }
    await initPromise;
  };

  const listLatestThreadRuns = async (
    resourceId: string
  ): Promise<readonly AssistantThreadRunRecord[]> => {
    await initialize();
    const result = await database.query<Record<string, unknown>>(
      `SELECT
          latest_run.id,
          latest_run.resource_id AS "resourceId",
          latest_run.thread_id AS "threadId",
          latest_run.provider,
          latest_run.model,
          latest_run.model_settings AS "modelSettings",
          latest_run.provider_options AS "providerOptions",
          latest_run.runtime_kind AS "runtimeKind",
          latest_run.status,
          latest_run.error,
          latest_run.started_at AS "startedAt",
          latest_run.completed_at AS "completedAt",
          latest_run.created_at AS "createdAt",
          latest_run.updated_at AS "updatedAt",
          latest_run.turn_message_id AS "turnMessageId"
       FROM (${LATEST_THREAD_RUNS_BY_RESOURCE_SQL}) AS latest_run`,
      [resourceId]
    );
    return result.rows.map(toThreadRunRecord);
  };

  const listThreadCheckpoints = async (
    threadId: string
  ): Promise<readonly AssistantEditCheckpointRecord[]> => {
    await initialize();
    // Read-through only (Path A, like listThreadRunEvents). Queried across ALL
    // runs (not narrowed to the latest run) so past turns' edit cards stay
    // revertible after reload. before_content is intentionally NOT selected —
    // the raw prior bytes never leave the main process; revert reads them there.
    const result = await database.query<Record<string, unknown>>(
      `SELECT
          id,
          run_id AS "runId",
          resource_id AS "resourceId",
          thread_id AS "threadId",
          tool_call_id AS "toolCallId",
          tool_name AS "toolName",
          op,
          root_id AS "rootId",
          path,
          from_path AS "fromPath",
          before_existed AS "beforeExisted",
          before_hash AS "beforeHash",
          before_size AS "beforeSize",
          after_existed AS "afterExisted",
          after_hash AS "afterHash",
          capture_status AS "captureStatus",
          reverted_at AS "revertedAt",
          occurred_at AS "occurredAt"
       FROM ${ASSISTANT_EDIT_CHECKPOINTS_TABLE}
       WHERE thread_id = $1
       ORDER BY occurred_at ASC, id ASC`,
      [threadId]
    );
    return result.rows.map(toEditCheckpointRecord);
  };

  const listThreadRunEvents = async (
    threadId: string,
    resourceId: string,
    options?: AssistantThreadRunEventListOptions
  ): Promise<readonly AssistantRunEvent[]> => {
    await initialize();
    const limitLatestRuns =
      typeof options?.limitLatestRuns === 'number' && Number.isSafeInteger(options.limitLatestRuns)
        ? options.limitLatestRuns
        : undefined;
    if (limitLatestRuns !== undefined && limitLatestRuns < 1) {
      throw new Error('Assistant run event history limit must be a positive safe integer.');
    }
    const params: unknown[] = [threadId, resourceId];
    const boundedRunFilter =
      limitLatestRuns === undefined
        ? ''
        : `AND run.id IN (
            SELECT recent_run.id
            FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS recent_run
            WHERE recent_run.thread_id = $1 AND recent_run.resource_id = $2
            ORDER BY recent_run.started_at DESC, recent_run.created_at DESC, recent_run.id DESC
            LIMIT $3
          )`;
    if (limitLatestRuns !== undefined) {
      params.push(limitLatestRuns);
    }
    const result = await database.query<Record<string, unknown>>(
      `SELECT
          event.id,
          event.run_id,
          event.sequence,
          event.kind,
          event.status,
          event.label,
          event.detail,
          event.duration_ms,
          event.metadata,
          event.occurred_at
       FROM ${ASSISTANT_RUN_EVENTS_TABLE} AS event
       INNER JOIN ${ASSISTANT_THREAD_RUNS_TABLE} AS run ON run.id = event.run_id
       WHERE event.thread_id = $1
          AND event.resource_id = $2
          ${boundedRunFilter}
       ORDER BY run.started_at ASC, run.created_at ASC, run.id ASC,
                event.sequence ASC, event.occurred_at ASC, event.id ASC`,
      params
    );
    return result.rows.map(toThreadRunEvent);
  };

  const repository: BulkAssistantThreadRepository = {
    async appendThreadRunEvent(runId: string, event: AssistantRunEvent): Promise<void> {
      await initialize();
      const sequence = event.sequence ?? 0;
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error('Assistant run event sequence must be a non-negative safe integer.');
      }
      const occurredAt = normalizeDate(event.timestamp);
      const sanitizedMetadata = sanitizeAssistantRunEventMetadata(event.metadata);
      const now = new Date();
      await database.query(
        `INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}
          (
            id,
            run_id,
            resource_id,
            thread_id,
            sequence,
            kind,
            status,
            label,
            detail,
            metadata,
            duration_ms,
            occurred_at,
            created_at,
            updated_at
          )
         SELECT
            $1,
            runs.id,
            runs.resource_id,
            runs.thread_id,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8::jsonb,
            $9,
            $10,
            $11,
            $12
         FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
         WHERE runs.id = $2
         ON CONFLICT (id) DO UPDATE SET
            sequence = EXCLUDED.sequence,
            kind = EXCLUDED.kind,
            status = EXCLUDED.status,
            label = EXCLUDED.label,
            detail = EXCLUDED.detail,
            metadata = EXCLUDED.metadata,
            duration_ms = EXCLUDED.duration_ms,
            occurred_at = EXCLUDED.occurred_at,
            updated_at = EXCLUDED.updated_at`,
        [
          event.id,
          runId,
          sequence,
          event.kind,
          event.status,
          event.label,
          event.detail ?? null,
          sanitizedMetadata ? JSON.stringify(sanitizedMetadata) : null,
          event.durationMs ?? null,
          occurredAt,
          now,
          now,
        ]
      );
    },
    async completeThreadRun(runId: string, input: CompleteAssistantThreadRunInput): Promise<void> {
      await initialize();
      await database.query(
        `UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}
         SET status = $2, error = $3, completed_at = $4, updated_at = $5
         WHERE id = $1`,
        [runId, input.status, input.error ?? null, new Date(), new Date()]
      );
    },
    async createThread(resourceId: string, title?: string): Promise<AssistantMemoryThread> {
      await initialize();
      const now = new Date();
      const thread = {
        createdAt: now,
        id: createThreadId(),
        resourceId,
        title: resolveInitialThreadTitle(title),
        updatedAt: now,
      } satisfies AssistantMemoryThread;
      await database.query(
        `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
          (id, "resourceId", title, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          thread.id,
          thread.resourceId,
          thread.title,
          // Only the default title is an OM-owned placeholder. An explicit
          // creation title is user-owned and must never be auto-overwritten.
          JSON.stringify({
            source: 'brainstrike',
            ...(title === undefined
              ? { [THREAD_TITLE_SOURCE_METADATA_KEY]: THREAD_TITLE_SOURCE_OM }
              : {}),
          }),
          thread.createdAt,
          thread.updatedAt,
        ]
      );
      return thread;
    },
    async createThreadRun(input: CreateAssistantThreadRunInput): Promise<AssistantThreadRunRecord> {
      await initialize();
      const now = new Date();
      const startedAt = input.startedAt ?? now;
      const completedAt = input.completedAt ?? null;
      const record = {
        completedAt,
        createdAt: now,
        error: input.error ?? null,
        id: input.id,
        model: input.model,
        provider: input.provider,
        resourceId: input.resourceId,
        runtimeKind: input.runtimeKind,
        startedAt,
        status: input.status ?? 'running',
        threadId: input.threadId,
        turnMessageId: input.turnMessageId ?? null,
        updatedAt: now,
        ...(input.modelSettings ? { modelSettings: { ...input.modelSettings } } : {}),
        ...(input.providerOptions ? { providerOptions: { ...input.providerOptions } } : {}),
      } satisfies AssistantThreadRunRecord;
      await database.query(
        `INSERT INTO ${ASSISTANT_THREAD_RUNS_TABLE}
          (
            id,
            resource_id,
            thread_id,
            provider,
            model,
            model_settings,
            provider_options,
            runtime_kind,
            status,
            error,
            started_at,
            completed_at,
            created_at,
            updated_at,
            turn_message_id
          )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          record.id,
          record.resourceId,
          record.threadId,
          record.provider,
          record.model,
          record.modelSettings ? JSON.stringify(record.modelSettings) : null,
          record.providerOptions ? JSON.stringify(record.providerOptions) : null,
          record.runtimeKind,
          record.status,
          record.error,
          record.startedAt,
          record.completedAt,
          record.createdAt,
          record.updatedAt,
          record.turnMessageId,
        ]
      );
      return record;
    },
    async deleteThread(threadId: string): Promise<void> {
      await initialize();
      // Sidecar stages derive from the ONE shared cascade spec so the
      // single/bulk CTEs (and the Mastra store override) can never drift in
      // stage-set or ordering again (BST-993). This path previously omitted
      // thread placements and relied on the panel's separate
      // clearThreadPlacement round trip; the CTE now owns the full cascade
      // (placements without a live thread were already inert by contract).
      const sidecarStages = THREAD_DELETE_SIDECAR_TABLES.map(
        ({ table, threadColumn }) => `deleted_${table} AS (
            DELETE FROM ${table}
            WHERE ${threadColumn} = $1
            RETURNING ${threadColumn}
          )`
      ).join(',\n          ');
      const sidecarCounts = THREAD_DELETE_SIDECAR_TABLES.map(
        ({ table }) => `(SELECT count(*) FROM deleted_${table}) AS "deleted_${table}_count"`
      ).join(',\n          ');
      await database.query(
        `WITH deleted_observational_memory AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
            WHERE "threadId" = $1 OR "lookupKey" = $2
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.messages}
            WHERE thread_id = $1
            RETURNING id
          ),
          ${sidecarStages},
          deleted_thread AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.threads}
            WHERE id = $1
            RETURNING id, "resourceId"
          ),
          inserted_mind_ops AS (
            INSERT INTO ${MIND_OPS_TABLE} (entity_kind, entity_id, op, resource_id)
            SELECT 'thread', id, 'delete', "resourceId" FROM deleted_thread
            RETURNING seq
          )
         SELECT
          (SELECT count(*) FROM deleted_observational_memory) AS deleted_observational_memory_count,
          (SELECT count(*) FROM deleted_messages) AS deleted_message_count,
          ${sidecarCounts},
          (SELECT count(*) FROM deleted_thread) AS deleted_thread_count,
          (SELECT count(*) FROM inserted_mind_ops) AS inserted_mind_op_count`,
        [threadId, `thread:${threadId}`]
      );
    },
    async deleteThreads(threadIds: readonly string[]): Promise<void> {
      requireAssistantThreadIds(threadIds);
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `WITH requested(id) AS (
            VALUES ${threadIdValuesSql(threadIds)}
          ),
          validation AS (
            SELECT COUNT(threads.id) = ${threadIds.length} AS all_found
            FROM requested
            LEFT JOIN ${MASTRA_MEMORY_TABLES.threads} AS threads ON threads.id = requested.id
          ),
          deleted_observational_memory AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
            WHERE (SELECT all_found FROM validation)
              AND (
                "threadId" IN (SELECT id FROM requested)
                OR "lookupKey" IN (SELECT 'thread:' || id FROM requested)
              )
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.messages}
            WHERE (SELECT all_found FROM validation)
              AND thread_id IN (SELECT id FROM requested)
            RETURNING id
          ),
          ${THREAD_DELETE_SIDECAR_TABLES.map(
            ({ table, threadColumn }) => `deleted_${table} AS (
            DELETE FROM ${table}
            WHERE (SELECT all_found FROM validation)
              AND ${threadColumn} IN (SELECT id FROM requested)
            RETURNING ${threadColumn}
          )`
          ).join(',\n          ')},
          deleted_threads AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.threads}
            WHERE (SELECT all_found FROM validation)
              AND id IN (SELECT id FROM requested)
            RETURNING id, "resourceId"
          ),
          inserted_mind_ops AS (
            INSERT INTO ${MIND_OPS_TABLE} (entity_kind, entity_id, op, resource_id)
            SELECT 'thread', id, 'delete', "resourceId" FROM deleted_threads
            RETURNING seq
          )
         SELECT
          (SELECT all_found FROM validation) AS "allFound",
          (SELECT count(*) FROM deleted_observational_memory) AS "deletedObservationalMemoryCount",
          (SELECT count(*) FROM deleted_messages) AS "deletedMessageCount",
          ${THREAD_DELETE_SIDECAR_TABLES.map(
            ({ table }) => `(SELECT count(*) FROM deleted_${table}) AS "deleted_${table}_count"`
          ).join(',\n          ')},
          (SELECT count(*) FROM deleted_threads) AS "deletedThreadCount",
          (SELECT count(*) FROM inserted_mind_ops) AS "insertedMindOpCount"`,
        [...threadIds]
      );
      assertAllBulkThreadsFound(result.rows[0]);
    },
    async getCrossRootUsage(resourceId: string): Promise<readonly CrossRootUsageRow[]> {
      await initialize();
      // Single source of truth shared with the reactive live-query hook
      // (CROSS_ROOT_USAGE_AGGREGATION_SQL + mapCrossRootUsageRow) so the
      // grouping/ordering/roots-join and the strict no-fabrication parse can
      // never drift between the validated method and the panel's query.
      const result = await database.query<Record<string, unknown>>(
        CROSS_ROOT_USAGE_AGGREGATION_SQL,
        [resourceId]
      );
      return result.rows.map(mapCrossRootUsageRow);
    },
    async getRunLedger(
      resourceId: string,
      options?: RunLedgerListOptions
    ): Promise<readonly RunLedgerRow[]> {
      const limit = options?.limitLatest ?? RUN_LEDGER_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > RUN_LEDGER_MAX_LIMIT) {
        throw new Error(`Run ledger limitLatest must be between 1 and ${RUN_LEDGER_MAX_LIMIT}.`);
      }
      await initialize();
      // Single source of truth shared with any future reactive consumer
      // (RUN_LEDGER_AGGREGATION_SQL + mapRunLedgerRow) — same convention as
      // getCrossRootUsage.
      const result = await database.query<Record<string, unknown>>(RUN_LEDGER_AGGREGATION_SQL, [
        resourceId,
        limit,
      ]);
      return result.rows.map(mapRunLedgerRow);
    },
    async getThreadCumulativeUsage(threadId: string): Promise<ThreadCumulativeUsage | null> {
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `SELECT
            provider,
            model,
            run_kind AS "runKind",
            SUM(input_tokens)::bigint AS "inputTokens",
            SUM(output_tokens)::bigint AS "outputTokens",
            SUM(COALESCE(cache_read_input_tokens, 0))::bigint AS "cacheReadTokens",
            SUM(COALESCE(cache_creation_input_tokens, 0))::bigint AS "cacheCreationTokens",
            SUM(billed_cost_usd) AS "billedCostUsd",
            SUM(CASE WHEN billed_cost_usd IS NULL THEN input_tokens ELSE 0 END)::bigint
              AS "estimatedInputTokens",
            SUM(CASE WHEN billed_cost_usd IS NULL THEN output_tokens ELSE 0 END)::bigint
              AS "estimatedOutputTokens",
            SUM(CASE WHEN billed_cost_usd IS NULL THEN COALESCE(cache_read_input_tokens, 0) ELSE 0 END)::bigint
              AS "estimatedCacheReadTokens",
            SUM(CASE WHEN billed_cost_usd IS NULL THEN COALESCE(cache_creation_input_tokens, 0) ELSE 0 END)::bigint
              AS "estimatedCacheCreationTokens"
         FROM ${ASSISTANT_RUN_USAGE_TABLE}
         WHERE thread_id = $1
         GROUP BY provider, model, run_kind
         ORDER BY provider ASC, model ASC, run_kind ASC`,
        [threadId]
      );
      if (result.rows.length === 0) {
        return null;
      }
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const perModel = result.rows.map((row) => {
        const inputTokens = requireNonNegativeInteger(row['inputTokens'], 'inputTokens');
        const outputTokens = requireNonNegativeInteger(row['outputTokens'], 'outputTokens');
        const billedCostUsd = optionalNonNegativeFiniteNumber(
          row['billedCostUsd'],
          'billedCostUsd'
        );
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
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
          cacheCreationTokens: requireNonNegativeInteger(
            row['cacheCreationTokens'] ?? 0,
            'cacheCreationTokens'
          ),
          cacheReadTokens: requireNonNegativeInteger(
            row['cacheReadTokens'] ?? 0,
            'cacheReadTokens'
          ),
          estimatedCacheCreationTokens: requireNonNegativeInteger(
            row['estimatedCacheCreationTokens'] ?? 0,
            'estimatedCacheCreationTokens'
          ),
          estimatedCacheReadTokens: requireNonNegativeInteger(
            row['estimatedCacheReadTokens'] ?? 0,
            'estimatedCacheReadTokens'
          ),
          inputTokens,
          model: requireString(row['model'], 'model'),
          outputTokens,
          provider: requireString(row['provider'], 'provider'),
          runKind: requireRunUsageKind(row['runKind']),
        } satisfies ThreadModelUsageSubtotal;
      });
      return { perModel, totalInputTokens, totalOutputTokens };
    },
    async getThreadRunTurnMessageId(runId: string, threadId: string): Promise<string | null> {
      requireString(runId, 'runId');
      requireString(threadId, 'threadId');
      await initialize();
      const result = await database.query<{ turnMessageId: string | null }>(
        `SELECT turn_message_id AS "turnMessageId"
         FROM ${ASSISTANT_THREAD_RUNS_TABLE}
         WHERE id = $1 AND thread_id = $2`,
        [runId, threadId]
      );
      const value = result.rows[0]?.turnMessageId;
      return typeof value === 'string' && value.length > 0 ? value : null;
    },
    listLatestThreadRuns,
    async listMessages(
      threadId: string,
      resourceId: string,
      options?: AssistantThreadMessageListOptions
    ): Promise<readonly AssistantHistoryMessage[]> {
      await initialize();
      const limitLatest =
        typeof options?.limitLatest === 'number' && Number.isSafeInteger(options.limitLatest)
          ? options.limitLatest
          : undefined;
      if (limitLatest !== undefined && limitLatest < 1) {
        throw new Error('Assistant message history limit must be a positive safe integer.');
      }
      const params: unknown[] = [threadId, resourceId];
      const limitClause =
        limitLatest === undefined
          ? ''
          : `-- id is a deterministic tie-breaker for same-timestamp rows;
               -- insertion-order ties need a future monotonic schema column.
               ORDER BY "createdAt" DESC, id DESC
               LIMIT $3`;
      // Soft-rewind exclusion (BST-1115) sits INSIDE the windowing subquery, so
      // it applies before `limitLatest` — the hydration window is the latest N
      // VISIBLE messages, not N rows of which some are then dropped. Reload
      // hydration is this query, which is why a tombstoned message stays gone
      // across a restart without any renderer-side memory of the rewind.
      const sql = `SELECT
          recent_messages.id,
          recent_messages.role,
          recent_messages.content,
          recent_messages."createdAt",
          message_parents.message_id AS "parentMappingMessageId",
          message_parents.parent_id AS "parentId"
        FROM (
          SELECT id, role, content, "createdAt"
          FROM ${MASTRA_MEMORY_TABLES.messages}
          WHERE thread_id = $1 AND "resourceId" = $2
            AND NOT EXISTS (
              SELECT 1 FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} AS tombstones
              WHERE tombstones.message_id = ${MASTRA_MEMORY_TABLES.messages}.id
            )
          ${limitClause}
        ) AS recent_messages
        LEFT JOIN ${ASSISTANT_MESSAGE_PARENTS_TABLE} AS message_parents
          ON message_parents.message_id = recent_messages.id
          AND message_parents.thread_id = $1
          AND message_parents.resource_id = $2
        ORDER BY recent_messages."createdAt" ASC, recent_messages.id ASC`;
      if (limitLatest !== undefined) {
        params.push(limitLatest);
      }
      const result = await database.query<Record<string, unknown>>(sql, params);
      return result.rows.map(mapAssistantHistoryMessageRow);
    },
    listThreadCheckpoints,
    listThreadRunEvents,
    async listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]> {
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `SELECT
           threads.id,
           threads."resourceId",
           threads.title,
           threads.metadata,
           threads."createdAt",
           threads."updatedAt",
           latest_run.id AS "latestRunId",
           latest_run.resource_id AS "latestRunResourceId",
           latest_run.thread_id AS "latestRunThreadId",
           latest_run.provider AS "latestRunProvider",
           latest_run.model AS "latestRunModel",
           latest_run.model_settings AS "latestRunModelSettings",
           latest_run.provider_options AS "latestRunProviderOptions",
           latest_run.runtime_kind AS "latestRunRuntimeKind",
           latest_run.status AS "latestRunStatus",
           latest_run.error AS "latestRunError",
           latest_run.started_at AS "latestRunStartedAt",
           latest_run.completed_at AS "latestRunCompletedAt",
           latest_run.created_at AS "latestRunCreatedAt",
           latest_run.updated_at AS "latestRunUpdatedAt",
           latest_run.turn_message_id AS "latestRunTurnMessageId"
         FROM ${MASTRA_MEMORY_TABLES.threads} AS threads
         LEFT JOIN (
           ${LATEST_THREAD_RUNS_BY_RESOURCE_SQL}
         ) AS latest_run ON latest_run.thread_id = threads.id
         WHERE threads."resourceId" = $1
         ORDER BY threads."updatedAt" DESC, threads.id DESC`,
        [resourceId]
      );
      return result.rows.map((row) => {
        const threadId = requireString(row['id'], 'id');
        const latestRun = toLatestThreadRunRecord(row);
        return toMemoryThread({
          createdAt: row['createdAt'],
          id: threadId,
          metadata: parseJson(row['metadata']),
          resourceId: requireString(row['resourceId'], 'resourceId'),
          title: typeof row['title'] === 'string' ? row['title'] : null,
          updatedAt: row['updatedAt'],
          ...(latestRun ? { latestRun } : {}),
        });
      });
    },
    async recordMessageParent(input: RecordAssistantMessageParentInput): Promise<void> {
      const messageId = requireNonEmptyTopologyId(input.messageId, 'messageId');
      const threadId = requireNonEmptyTopologyId(input.threadId, 'threadId');
      const resourceId = requireNonEmptyTopologyId(input.resourceId, 'resourceId');
      const parentId =
        input.parentId === null ? null : requireNonEmptyTopologyId(input.parentId, 'parentId');
      await initialize();
      const now = new Date();
      const result = await database.query(
        `INSERT INTO ${ASSISTANT_MESSAGE_PARENTS_TABLE}
          (message_id, thread_id, resource_id, parent_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (message_id) DO UPDATE
           SET updated_at = EXCLUDED.updated_at
           WHERE ${ASSISTANT_MESSAGE_PARENTS_TABLE}.thread_id = EXCLUDED.thread_id
             AND ${ASSISTANT_MESSAGE_PARENTS_TABLE}.resource_id = EXCLUDED.resource_id
             AND ${ASSISTANT_MESSAGE_PARENTS_TABLE}.parent_id IS NOT DISTINCT FROM EXCLUDED.parent_id
         RETURNING message_id`,
        [messageId, threadId, resourceId, parentId, now]
      );
      if (result.rows.length !== 1) {
        throw new Error(`Assistant message ${messageId} has conflicting branch topology.`);
      }
    },
    async recordRunOutcome(input: RecordRunOutcomeInput): Promise<void> {
      requireString(input.runId, 'runId');
      requireString(input.threadId, 'threadId');
      requireString(input.resourceId, 'resourceId');
      if (!ASSISTANT_RUN_OUTCOME_VERDICTS.includes(input.verdict)) {
        throw new Error(`Invalid run outcome verdict: ${String(input.verdict)}`);
      }
      if (!ASSISTANT_RUN_OUTCOME_SOURCES.includes(input.source)) {
        throw new Error(`Invalid run outcome source: ${String(input.source)}`);
      }
      if (input.detail !== undefined && input.detail.length > RUN_OUTCOME_DETAIL_MAX_CHARS) {
        // Bounded storage, never silent truncation: the caller owns shortening.
        throw new Error(`Run outcome detail exceeds ${RUN_OUTCOME_DETAIL_MAX_CHARS} characters.`);
      }
      await initialize();
      // One label per run: a later verdict replaces the earlier one (a user
      // verdict overriding a derived edit_revert or hook label is the intended
      // flow). EXCEPTION: NO derived writer ('hook' OR 'edit_revert') ever
      // overwrites an explicit 'user' label — the conflict clause carries the
      // precedence rule so it holds in SQL, byte-consistent with the
      // main-process writer (apps/desktop assistant-server/run-persistence.ts
      // recordDesktopAssistantHookRunOutcome). Review #1694: without this, a
      // post-verdict revert would silently clobber the user's authoritative
      // verdict.
      const conflictGuard =
        input.source === 'user' ? '' : ` WHERE ${ASSISTANT_RUN_OUTCOMES_TABLE}.source <> 'user'`;
      await database.query(
        `INSERT INTO ${ASSISTANT_RUN_OUTCOMES_TABLE}
          (run_id, thread_id, resource_id, verdict, source, detail, labeled_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (run_id) DO UPDATE SET
          thread_id = EXCLUDED.thread_id,
          resource_id = EXCLUDED.resource_id,
          verdict = EXCLUDED.verdict,
          source = EXCLUDED.source,
          detail = EXCLUDED.detail,
          labeled_at = EXCLUDED.labeled_at,
          updated_at = NOW()${conflictGuard}`,
        [
          input.runId,
          input.threadId,
          input.resourceId,
          input.verdict,
          input.source,
          input.detail ?? null,
          input.labeledAt ?? new Date(),
        ]
      );
    },
    async recordRunUsage(input: RecordRunUsageInput): Promise<void> {
      assertUsageTokenCount(input.inputTokens, 'inputTokens');
      assertUsageTokenCount(input.outputTokens, 'outputTokens');
      if (
        input.billedCostUsd !== undefined &&
        (!Number.isFinite(input.billedCostUsd) || input.billedCostUsd < 0)
      ) {
        throw new Error('Assistant run usage billedCostUsd must be a finite, non-negative number.');
      }
      if (input.cacheReadInputTokens !== undefined) {
        assertUsageTokenCount(input.cacheReadInputTokens, 'cacheReadInputTokens');
      }
      if (input.cacheCreationInputTokens !== undefined) {
        assertUsageTokenCount(input.cacheCreationInputTokens, 'cacheCreationInputTokens');
      }
      if (
        (input.cacheReadInputTokens ?? 0) + (input.cacheCreationInputTokens ?? 0) >
        input.inputTokens
      ) {
        // inputTokens is the TOTAL the model saw; the cache classes are shares
        // of it. A row violating that would poison every downstream estimate.
        throw new Error('Assistant run usage cache token classes exceed total inputTokens.');
      }
      await initialize();
      await database.query(
        `INSERT INTO ${ASSISTANT_RUN_USAGE_TABLE}
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, created_at, root_id, billed_cost_usd, cache_read_input_tokens, cache_creation_input_tokens, run_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          crypto.randomUUID(),
          input.threadId,
          input.runId,
          input.resourceId,
          input.model,
          input.provider,
          input.inputTokens,
          input.outputTokens,
          new Date(),
          input.rootId ?? null,
          input.billedCostUsd ?? null,
          input.cacheReadInputTokens ?? null,
          input.cacheCreationInputTokens ?? null,
          input.runKind ?? 'chat',
        ]
      );
    },
    async renameThread(threadId: string, title: string): Promise<void> {
      const normalizedTitle = title.trim();
      if (!normalizedTitle) {
        throw new Error('Thread title is required.');
      }
      await initialize();
      // A manual rename is user-owned: clear the OM marker (if present) so no
      // later auto-title write can ever overwrite this title again.
      await database.query(
        `UPDATE ${MASTRA_MEMORY_TABLES.threads}
         SET title = $2, metadata = COALESCE(metadata, '{}'::jsonb) - $3, "updatedAt" = $4
         WHERE id = $1`,
        [threadId, normalizedTitle, THREAD_TITLE_SOURCE_METADATA_KEY, new Date()]
      );
    },
    async updateThreadMetadata(threadId: string, metadata: AssistantThreadMetadata): Promise<void> {
      assertPersistableThreadMetadata(metadata);
      const normalized = normalizeThreadMetadataForPersistence(metadata);
      await initialize();
      await database.query(
        `UPDATE ${MASTRA_MEMORY_TABLES.threads}
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
         WHERE id = $1`,
        [threadId, JSON.stringify(normalized)]
      );
    },
    async updateThreadsMetadata(
      threadIds: readonly string[],
      metadata: AssistantThreadMetadata
    ): Promise<void> {
      requireAssistantThreadIds(threadIds);
      requireNonemptyThreadMetadata(metadata);
      const normalized = normalizeThreadMetadataForPersistence(metadata);
      await initialize();
      const metadataParameter = threadIds.length + 1;
      const result = await database.query<Record<string, unknown>>(
        `WITH requested(id) AS (
            VALUES ${threadIdValuesSql(threadIds)}
          ),
          validation AS (
            SELECT COUNT(threads.id) = ${threadIds.length} AS all_found
            FROM requested
            LEFT JOIN ${MASTRA_MEMORY_TABLES.threads} AS threads ON threads.id = requested.id
          ),
          updated_threads AS (
            UPDATE ${MASTRA_MEMORY_TABLES.threads} AS threads
            SET metadata = COALESCE(threads.metadata, '{}'::jsonb) || $${metadataParameter}::jsonb
            FROM requested
            WHERE (SELECT all_found FROM validation)
              AND threads.id = requested.id
            RETURNING threads.id
          )
         SELECT
          (SELECT all_found FROM validation) AS "allFound",
          (SELECT count(*) FROM updated_threads) AS "updatedThreadCount"`,
        [...threadIds, JSON.stringify(normalized)]
      );
      assertAllBulkThreadsFound(result.rows[0]);
    },
  };
  assistantThreadRepositoryCache.set(database, repository);
  return repository;
}

export function createAssistantThreadHistoryAdapter({
  discoverSuspendedRuns,
  repository,
  resourceId,
  threadId,
}: {
  /**
   * Desktop-only capability: rediscover approvals AND suspend() pauses
   * stranded by a restart/reload (see assistant-suspended-approvals.ts).
   * Omitted on web (no assistant server / storage, so web never suspends),
   * where its absence means "no suspended pauses" and hydration is
   * byte-identical to today.
   */
  readonly discoverSuspendedRuns?: SuspendedRunDiscovery;
  readonly repository: AssistantThreadRepository;
  readonly resourceId: string;
  readonly threadId: string;
}): AssistantUiThreadHistoryAdapter {
  // DURABLE-PARENT INVARIANT (BST-1243): every persisted edge must reference a
  // durable (Mastra-persisted) message id or null. Approval/suspend flows
  // append UI-transient messages — the action echo, the post-resume leg, and
  // the synthetic rediscovered-pause notices — that Mastra deliberately never
  // persists; persisting their edges (or chaining a real message onto their
  // ids) dangles the graph, and reload hydration re-roots the child into a
  // phantom root carousel sibling. The maps below alias each transient id to
  // its nearest durable ancestor so persisted topology skips them entirely.
  const transientParentByAliasId = new Map<string, string | null>();
  const hydratedParentById = new Map<string, string | null>();
  const persistedEdgeIds = new Set<string>();
  let durableTailId: string | null = null;

  const resolveDurableParentId = (parentId: string | null): string | null => {
    let current = parentId;
    const seen = new Set<string>();
    while (current !== null && transientParentByAliasId.has(current)) {
      if (seen.has(current)) {
        throw new Error(`Assistant history transient-parent aliases form a cycle at ${current}.`);
      }
      seen.add(current);
      current = transientParentByAliasId.get(current) ?? null;
    }
    return current;
  };

  const recordParentEdge = async (messageId: string, parentId: string | null): Promise<void> => {
    if (!repository.recordMessageParent) {
      throw new Error('Assistant history repository cannot persist message branch topology.');
    }
    await repository.recordMessageParent({ messageId, parentId, resourceId, threadId });
    persistedEdgeIds.add(messageId);
  };

  // The echo is transport bookkeeping with no durable row — never an edge.
  // Its parent is the SUSPENDED assistant message, whose own runEnd append
  // never fires (suspension interrupts it), so backfill that durable edge
  // here; otherwise the reload group keys to a snapshot row id and every
  // descendant edge dangles. The backfill parent, in order of authority: the
  // hydrated graph parent when the suspended message was loaded; else the
  // suspending run's durable turn anchor (BST-1163 `turn_message_id`, stamped
  // identically on every leg of the turn — exact even when other sends landed
  // during the suspension or the suspended run was a regeneration branched
  // from an older prompt); else the live session tail as a legacy last resort
  // (runs predating the turn link). The repository upsert stays loud on
  // conflicting topology.
  const recordActionEchoAppend = async (
    message: unknown,
    resolvedParentId: string | null
  ): Promise<void> => {
    if (resolvedParentId === null || persistedEdgeIds.has(resolvedParentId)) {
      return;
    }
    let suspendedParentId: string | null;
    if (hydratedParentById.has(resolvedParentId)) {
      suspendedParentId = hydratedParentById.get(resolvedParentId) ?? null;
    } else {
      const actionRunId = readActionMessageRunId(message);
      const turnMessageId =
        actionRunId !== undefined && repository.getThreadRunTurnMessageId
          ? await repository.getThreadRunTurnMessageId(actionRunId, threadId)
          : null;
      suspendedParentId = turnMessageId ?? durableTailId;
    }
    await recordParentEdge(resolvedParentId, suspendedParentId);
  };

  return {
    async append(item) {
      // Mastra remains the only durable CONTENT writer. assistant-ui owns the
      // branch graph, so persist only its id/parent edge here; writing the
      // message body would duplicate or race Mastra's snapshots.
      if (!repository.recordMessageParent) {
        throw new Error('Assistant history repository cannot persist message branch topology.');
      }
      const resolvedParentId = resolveDurableParentId(item.parentId);
      if (isApprovalActionMessage(item.message)) {
        transientParentByAliasId.set(item.message.id, resolvedParentId);
        await recordActionEchoAppend(item.message, resolvedParentId);
        return;
      }
      if (
        item.message.role === 'assistant' &&
        item.parentId !== null &&
        transientParentByAliasId.has(item.parentId)
      ) {
        // A resume leg: the transient assistant-ui message continuing a
        // suspended run (its content persists under a fresh Mastra snapshot
        // id inside the suspended message's hydration group). Alias it so the
        // next real message chains onto the durable suspended id instead.
        // DELIBERATE v1 SCOPE: this also catches a REGENERATION taken from a
        // post-approval response (assistant-ui re-appends it with the echo as
        // parent, indistinguishable here from a resume leg). Its Mastra
        // content persists and hydrates chronologically inside the turn's
        // group; only the carousel affordance is not reconstructed after
        // reload. Distinguishing the two would require a timing-sensitive
        // probe of Mastra's row store — rejected; pinned by the
        // "regeneration taken from a post-approval response" case in
        // assistant-approval-topology.integration.test.ts.
        transientParentByAliasId.set(item.message.id, resolvedParentId);
        return;
      }
      await recordParentEdge(item.message.id, resolvedParentId);
      durableTailId = item.message.id;
    },
    async load() {
      // Discovery is a bounded, best-effort HTTP round-trip (see
      // assistant-suspended-approvals.ts) and the rare case, so it runs
      // CONCURRENTLY with the history queries instead of gating them: thread
      // render waits at most max(history, discovery-timeout), never their sum.
      const [messages, runEvents, discovery] = await Promise.all([
        repository.listMessages(threadId, resourceId, {
          limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
        }),
        repository.listThreadRunEvents(threadId, resourceId, {
          limitLatestRuns: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
        }),
        discoverSuspendedRuns
          ? discoverSuspendedRuns(threadId, resourceId)
          : Promise.resolve({ approvals: [], suspends: [] } as const),
      ]);
      // Reseed session topology state from hydration (a re-load replaces it).
      transientParentByAliasId.clear();
      hydratedParentById.clear();
      persistedEdgeIds.clear();
      for (const message of messages) {
        if (message.parentId !== undefined) {
          persistedEdgeIds.add(message.id);
        }
      }
      const base = toHistoryRepository(messages, runEvents);
      for (const hydrated of base.messages) {
        hydratedParentById.set(hydrated.message.id, hydrated.parentId);
      }
      durableTailId = base.headId ?? null;
      const result = appendSuspendedPauseMessages(base, discovery.approvals, discovery.suspends);
      // Synthetic pause notices chain onto the durable head (and each other);
      // alias them in order so an approve from a rediscovered notice resolves
      // through to the durable graph.
      for (const hydrated of result.messages) {
        if (isSuspendedPauseMessageId(hydrated.message.id)) {
          transientParentByAliasId.set(
            hydrated.message.id,
            resolveDurableParentId(hydrated.parentId)
          );
        }
      }
      return result;
    },
  };
}
