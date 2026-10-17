import type {
  AssistantUiThreadHistoryAdapter,
  DelegatedConversationBaseline,
  DelegatedToolActionIdentity,
} from '@brainstrike/assistant-contract';
import {
  CHILD_INPUT_DELIVERY_METADATA_KEY,
  childInputDeliveryStateSchema,
  getToolActionIdentityKey,
  isGuardedToolError,
  NATIVE_MESSAGE_IDS_METADATA_KEY,
} from '@brainstrike/assistant-contract';
import {
  isApprovalActionMessage,
  readActionMessageHostRunId,
  readActionMessagePausedOwnerId,
} from '@brainstrike/assistant-contract/approval-action-message';
import type { AssistantDiscoveredRun } from '@brainstrike/assistant-contract/assistant-stream-session';
import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import {
  DEFAULT_THREAD_TITLE,
  MASTRA_MEMORY_TABLES,
  MIND_OPS_TABLE,
  THREAD_DELETE_SIDECAR_TABLES,
  THREAD_TITLE_SOURCE_METADATA_KEY,
  THREAD_TITLE_SOURCE_OM,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type AssistantRunEvent,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';
import {
  ASSISTANT_RUN_USAGE_KINDS,
  type AssistantRunUsageKind,
} from '@brainstrike/assistant-contract/run-usage';
import {
  createDeclinedToolCallResult,
  isDeclinedToolCallResult,
} from '@brainstrike/assistant-contract/tool-approval';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  type AssistantHistoryMessage,
  type AssistantThreadMessageListOptions,
  type AssistantThreadRunEventListOptions,
  readAssistantHistoryMessages,
  readAssistantHistoryRunEvents,
  recordAssistantHistoryParent,
} from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { Schema } from 'effect';
import type { DelegatedReplayProofInput } from './assistant-delegated-replay-proof';

export {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  type AssistantHistoryMessage,
  type AssistantThreadMessageListOptions,
  type AssistantThreadRunEventListOptions,
} from '@brainstrike/db';

export interface AssistantMemoryThread {
  readonly createdAt: Date;
  readonly id: string;
  readonly latestRun?: AssistantThreadRunRecord;
  readonly metadata?: AssistantThreadMetadata;
  /**
   * Why the thread's owner cannot read its log (an agent host thread whose
   * committed rows are damaged). The thread stays listed with its dates.
   */
  readonly readFailure?: string;
  readonly resourceId: string;
  readonly title: string;
  readonly updatedAt: Date;
}

import { ASSISTANT_THREAD_ICON_IDS, type AssistantThreadIconId } from '@brainstrike/types';

export { ASSISTANT_THREAD_ICON_IDS, type AssistantThreadIconId } from '@brainstrike/types';
export { ASSISTANT_THREAD_COLOR_IDS } from './assistant-thread-palette.js';

import {
  ASSISTANT_THREAD_COLOR_IDS,
  type AssistantThreadColorId,
} from './assistant-thread-palette.js';

export type { AssistantThreadColorId } from './assistant-thread-palette.js';

// biome-ignore assist/source/useSortedInterfaceMembers: BST-1391 Task 6 explicitly places forge fields immediately before model.
export interface AssistantThreadMetadata {
  /** Last observed branch of the thread's checkout. Display only — live from git. */
  readonly checkoutBranch?: string;
  /**
   * The `roots.id` a worktree hand-off returns to — the durable Local root,
   * recorded when the thread enters worktree mode so hand-off never guesses
   * from the position of an id in `secondaryRootIds`.
   */
  readonly checkoutLocalRootId?: string;
  /** Where this thread works: the folder's own checkout, or an isolated worktree. */
  readonly checkoutMode?: 'local' | 'worktree';
  /** `brainstrike_worktrees.id` — the AUTHORITY when `checkoutMode === 'worktree'`. */
  readonly checkoutWorktreeId?: string;
  /** Absolute worktree path retained for tooltips; never used as authority. */
  readonly checkoutWorktreePath?: string;
  readonly color?: AssistantThreadColorId;
  readonly icon?: AssistantThreadIconId;
  /**
   * The pull request this thread is driving, kept so "jump to the PR" works
   * offline and after `gh` is uninstalled. Display + navigation only: the
   * AUTHORITY for PR state is `brainstrike_forge_prs`, refreshed from gh.
   */
  readonly forgePrUrl?: string;
  /**
   * Whether check-transition notifications fire for this thread's PR
   * (spec §4.4's Watch toggle). ABSENT means watching: the user opted into
   * notifications globally, and a thread that has never touched the toggle
   * should not be quieter than one that has. Only an explicit `false` mutes.
   */
  readonly forgePrWatch?: boolean;
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

export type AssistantThreadRunStatus =
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'running';
export type AssistantThreadRuntimeKind = 'gateway' | 'hosted' | 'local';

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
  /** Resolve an ordinary approval/resume leg through its original native run. */
  readonly decision?: {
    readonly runId: string;
    readonly toolCallId: string;
  };
  readonly error?: string | null;
  /** Minted only by app-shell's `createThreadRunId` (see `HostRunId`). */
  readonly id: HostRunId;
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
  readonly status: Exclude<AssistantThreadRunStatus, 'running' | 'cancelling'>;
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
 * edit signals, and outcome label. `billedCostUsd` is absent (never
 * fabricated 0) when no usage row carried an exact provider-reported cost.
 * `durationMs` is null while the run is still open.
 */
export interface RunLedgerRow {
  readonly billedCostUsd?: number;
  readonly completedAt: Date | null;
  readonly durationMs: number | null;
  /**
   * Edits the run made. Only agent-host rows carry it (the host's run log
   * records each edit); a PGlite row has no edit record, so it omits the
   * count rather than claim zero.
   */
  readonly editCount?: number;
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
  /** Of `editCount`, the edits since reverted. Absent exactly when `editCount` is. */
  readonly revertedEditCount?: number;
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
 * many usage/event rows it produced. Tool counts deliberately cover
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

/** Catalog operations shared by host-owned desktop threads and web memory. */
export type AssistantThreadCatalogRepository = Pick<
  AssistantThreadRepository,
  | 'createThread'
  | 'listThreads'
  | 'deleteThread'
  | 'deleteThreads'
  | 'renameThread'
  | 'updateThreadMetadata'
  | 'updateThreadsMetadata'
>;

export interface AssistantThreadRepository {
  appendThreadRunEvent: (runId: string, event: AssistantRunEvent) => Promise<void>;
  completeThreadRun: (runId: string, input: CompleteAssistantThreadRunInput) => Promise<void>;
  createThread: (resourceId: string, title?: string) => Promise<AssistantMemoryThread>;
  createThreadRun: (input: CreateAssistantThreadRunInput) => Promise<AssistantThreadRunRecord>;
  deleteThread: (threadId: string) => Promise<void>;
  deleteThreads?: (threadIds: readonly string[]) => Promise<void>;
  getCrossRootUsage: (resourceId: string) => Promise<readonly CrossRootUsageRow[]>;
  /** Read an edge even when its transient UI message has no Mastra row. */
  getMessageParent?: (
    messageId: string,
    threadId: string,
    resourceId: string
  ) => Promise<string | null | undefined>;
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
  /**
   * REQUIRED, not optional: the approval/suspend echo backfill anchors a
   * suspended message on the host leg's turn and has no fallback, so a
   * repository without this method would throw on every live decision. Keeping
   * it required puts that gap in the compiler's hands instead of the user's.
   */
  getThreadRunTurnMessageId: (runId: string, threadId: string) => Promise<string | null>;
  hasPendingDelegatedToolCall?: (input: DelegatedReplayProofInput) => Promise<boolean>;
  hasResolvedToolCallInGeneration?: (hostRunId: string, toolCallId: string) => Promise<boolean>;
  listLatestThreadRuns: (resourceId: string) => Promise<readonly AssistantThreadRunRecord[]>;
  listMessages: (
    threadId: string,
    resourceId: string,
    options?: AssistantThreadMessageListOptions
  ) => Promise<readonly AssistantHistoryMessage[]>;
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
  /** The first host owner and later legs in its scoped generation. */
  sharesNativeRunGeneration?: (hostRunId: string, nativeRunId: string) => Promise<boolean>;
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

export interface RecordAssistantMessageParentInput {
  readonly messageId: string;
  readonly parentId: string | null;
  readonly resourceId: string;
  readonly threadId: string;
}

const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';

/**
 * The generation ONE generation read names, from the rows it matched.
 *
 * Every predicate behind those reads is a primary key —
 * `brainstrike_assistant_native_runs.native_run_id`, a continuation's `id`, an
 * invocation's `(root_thread_id, parent_runtime_run_id, parent_tool_call_id)` —
 * joined to its owner leg by `id`, so one row or none is the only possible
 * shape. A second row means that assumption is wrong; taking `rows[0]` of an
 * unordered result would pick a generation arbitrarily and give this leg a
 * ledger no sibling leg of its turn shares. The read says so instead.
 */
export function readSoleGenerationRunId(
  rows: readonly { readonly generationRunId: string | null }[]
): string | null {
  if (rows.length > 1) {
    throw new Error(
      `A generation read matched ${rows.length} rows; its predicate is a primary key and must match one row or none.`
    );
  }
  const value = rows[0]?.generationRunId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Ordinary initial sends own their generation; resumes use the existing native-run mapping. */
async function resolveGenerationRunId(
  database: Parameters<typeof createPgliteAssistantThreadRepository>[0],
  input: CreateAssistantThreadRunInput
): Promise<string | null> {
  const readGeneration = async (sql: string, values: unknown[]): Promise<string | null> => {
    const found = await database.query<{ generationRunId: string | null }>(
      sql,
      values as Parameters<typeof database.query>[1]
    );
    return readSoleGenerationRunId(found.rows);
  };
  if (input.decision) {
    return await readGeneration(
      `SELECT owner.generation_run_id AS "generationRunId"
         FROM brainstrike_assistant_native_runs mapped
         JOIN ${ASSISTANT_THREAD_RUNS_TABLE} owner ON owner.id = mapped.host_run_id
        WHERE mapped.native_run_id = $1 AND owner.resource_id = $2 AND owner.thread_id = $3`,
      [input.decision.runId, input.resourceId, input.threadId]
    );
  }
  return input.id;
}
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
/** Workspace roots (migration 039); joined by the cross-root usage rollup. */
const ROOTS_TABLE = 'roots';
const ASSISTANT_RUN_OUTCOMES_TABLE = 'brainstrike_assistant_run_outcomes';
/**
 * Every relation the repository reads or writes, and therefore every relation
 * whose absence means this database was never migrated.
 *
 * Read inside a function body, never at module scope: these are
 * `mastra-memory-schema` constants, and a module-scope read of them is the
 * BST-558 chunk-initialization hazard that
 * `scripts/verify-mastra-schema-init-order.mjs` guards.
 *
 * The thread-delete cascade references EVERY registered sidecar
 * unconditionally, so the sidecar list is derived rather than restated — a
 * sidecar added to the contract is probed the day it lands.
 */
export function requiredAssistantMemoryRelations(): readonly string[] {
  return [
    ...new Set([
      MASTRA_MEMORY_TABLES.threads,
      MASTRA_MEMORY_TABLES.messages,
      MASTRA_MEMORY_TABLES.observationalMemory,
      ASSISTANT_THREAD_RUNS_TABLE,
      ASSISTANT_RUN_EVENTS_TABLE,
      ASSISTANT_RUN_USAGE_TABLE,
      ASSISTANT_RUN_OUTCOMES_TABLE,
      MIND_OPS_TABLE,
      // `roots` is not assistant-owned (migration 039 creates it), but
      // CROSS_ROOT_USAGE_AGGREGATION_SQL reads it through `LEFT JOIN roots`.
      // Without it here, a handle carrying every assistant relation but no
      // roots table passes the probe and then raises a raw missing-relation
      // error from getCrossRootUsage() instead of the named one — the exact
      // inconsistent failure this probe exists to remove.
      ROOTS_TABLE,
      ...THREAD_DELETE_SIDECAR_TABLES.map((sidecar) => sidecar.table),
    ]),
  ].sort();
}

/**
 * Raised when the assistant memory schema is not present. Migrations 117/118
 * own that schema; nothing creates it at runtime any more.
 */
export class AssistantMemorySchemaMissingError extends Error {
  readonly missingRelations: readonly string[];

  constructor(missingRelations: readonly string[]) {
    super(
      `Assistant memory schema is incomplete: ${missingRelations.length} required relation(s) absent ` +
        `(${missingRelations.join(', ')}). This database was never migrated — run migrations before ` +
        'creating the assistant thread repository.'
    );
    this.name = 'AssistantMemorySchemaMissingError';
    this.missingRelations = missingRelations;
  }
}

/**
 * The schema check, and the reason it is a PROBE rather than a bootstrap.
 *
 * This repository used to `exec` a ~590-line `CREATE TABLE IF NOT EXISTS`
 * mirror of migrations 046-095 on first use per handle. On a migrated database
 * the `IF NOT EXISTS` never fired, which meant any divergence between the
 * mirror and the migrations was UNOBSERVABLE until a user hit a column the two
 * had shaped differently — a silent corruption with nothing pointing at its
 * cause. Migrations 117 (Mastra's memory schema) and 118 (the run header and
 * its event timeline) removed the last reason that mirror existed.
 *
 * `to_regclass` returns NULL for an absent relation instead of raising 42P01,
 * so one statement answers for the whole set and names exactly what is missing.
 * There is deliberately NO create-if-absent branch: a missing relation means
 * migrations did not run, and quietly creating it is precisely how the
 * divergence above was manufactured. The relation names are module constants
 * from `@brainstrike/assistant-contract`, never caller input, so inlining them
 * as literals carries no injection surface.
 */
async function assertAssistantMemorySchema(database: DbHandle): Promise<void> {
  const relations = requiredAssistantMemoryRelations();
  const relationValues = relations.map((relation) => `('${relation}')`).join(', ');
  const result = await database.query<{ relation: string }>(
    `SELECT required.relation
       FROM (VALUES ${relationValues}) AS required(relation)
      WHERE to_regclass('public.' || required.relation) IS NULL
      ORDER BY required.relation`
  );
  if (result.rows.length === 0) {
    return;
  }
  throw new AssistantMemorySchemaMissingError(result.rows.map((row) => row.relation));
}

const assistantThreadRepositoryCache = new WeakMap<DbHandle, BulkAssistantThreadRepository>();
const assistantThreadSchemaProbePromises = new WeakMap<DbHandle, Promise<void>>();
const ASSISTANT_THREAD_ICON_ID_SET = new Set<string>(ASSISTANT_THREAD_ICON_IDS);
const ASSISTANT_THREAD_COLOR_ID_SET = new Set<string>(ASSISTANT_THREAD_COLOR_IDS);
const ASSISTANT_THREAD_METADATA_KEYS = new Set<string>([
  'checkoutBranch',
  'checkoutLocalRootId',
  'checkoutMode',
  'checkoutWorktreeId',
  'checkoutWorktreePath',
  'color',
  'forgePrUrl',
  'forgePrWatch',
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

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
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

const CHECKOUT_MODES = new Set(['local', 'worktree']);

function optionalCheckoutMode(value: unknown): 'local' | 'worktree' | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || !CHECKOUT_MODES.has(value)) {
    throw new Error('Invalid assistant thread metadata checkout mode.');
  }
  return value as 'local' | 'worktree';
}

/**
 * All-or-nothing validation for the thread's checkout, mirroring
 * `assertCompleteOperatingRootMetadata`.
 *
 * `checkoutWorktreeId` is the AUTHORITY in worktree mode (exactly like
 * `operatingRootId` is for the folder binding), `checkoutWorktreePath` is the
 * display hint the chip's tooltip renders, and `checkoutLocalRootId` is the
 * durable root a later hand-off restores. New worktree writes need all three:
 * an id with no path renders a chip with nothing to show, a path with no id has
 * no durable identity to resolve, and a missing Local root would lose the
 * durable hand-off target. Reads tolerate only that last omission for legacy
 * rows, allowing the explicit warn/toast hand-off path to retain the current
 * primary folder. A LOCAL checkout carrying any of those keys is not "mostly
 * right" — it is two contradictory statements about where the thread works,
 * and it is rejected rather than silently pruned.
 *
 * `updateThreadMetadata` owns the key-removal transitions this shape needs.
 * Every checkout-mode patch removes the per-checkout branch before merging, so
 * a detached worktree cannot inherit the previous checkout's branch. A patch
 * specifically to Local also removes both worktree keys and the durable Local
 * root in the same SQL update. Every non-checkout metadata patch keeps the
 * repository's ordinary JSONB-merge semantics.
 */
interface CheckoutMetadataShape {
  readonly checkoutBranch?: string | undefined;
  readonly checkoutLocalRootId?: string | undefined;
  readonly checkoutMode?: 'local' | 'worktree' | undefined;
  readonly checkoutWorktreeId?: string | undefined;
  readonly checkoutWorktreePath?: string | undefined;
}

function assertCompleteCheckoutMetadata(
  metadata: CheckoutMetadataShape,
  requireLocalRootId: boolean
): void {
  const hasAnyCheckoutMetadata = Boolean(
    metadata.checkoutBranch ||
      metadata.checkoutLocalRootId ||
      metadata.checkoutMode ||
      metadata.checkoutWorktreeId ||
      metadata.checkoutWorktreePath
  );
  if (!hasAnyCheckoutMetadata) {
    return;
  }
  if (!metadata.checkoutMode) {
    throw new Error('Assistant thread checkout metadata is incomplete.');
  }
  if (metadata.checkoutMode === 'worktree') {
    if (
      !(metadata.checkoutWorktreeId && metadata.checkoutWorktreePath) ||
      (requireLocalRootId && !metadata.checkoutLocalRootId)
    ) {
      throw new Error('Assistant thread checkout metadata is incomplete.');
    }
    return;
  }
  if (
    metadata.checkoutLocalRootId ||
    metadata.checkoutWorktreeId ||
    metadata.checkoutWorktreePath
  ) {
    throw new Error('Assistant thread checkout metadata is inconsistent.');
  }
}

function assertCompleteCheckoutMetadataForRead(metadata: CheckoutMetadataShape): void {
  assertCompleteCheckoutMetadata(metadata, false);
}

function assertCompleteCheckoutMetadataForWrite(metadata: CheckoutMetadataShape): void {
  assertCompleteCheckoutMetadata(metadata, true);
}

function sanitizeCheckoutMetadata(
  value: Record<string, unknown>
): Pick<
  AssistantThreadMetadata,
  | 'checkoutBranch'
  | 'checkoutLocalRootId'
  | 'checkoutMode'
  | 'checkoutWorktreeId'
  | 'checkoutWorktreePath'
> {
  const checkoutBranch = optionalString(value['checkoutBranch']);
  const checkoutLocalRootId = optionalString(value['checkoutLocalRootId']);
  const checkoutMode = optionalCheckoutMode(value['checkoutMode']);
  const checkoutWorktreeId = optionalString(value['checkoutWorktreeId']);
  const checkoutWorktreePath = optionalString(value['checkoutWorktreePath']);
  const checkoutMetadata = {
    ...(checkoutBranch ? { checkoutBranch } : {}),
    ...(checkoutLocalRootId ? { checkoutLocalRootId } : {}),
    ...(checkoutMode ? { checkoutMode } : {}),
    ...(checkoutWorktreeId ? { checkoutWorktreeId } : {}),
    ...(checkoutWorktreePath ? { checkoutWorktreePath } : {}),
  };
  assertCompleteCheckoutMetadataForRead(checkoutMetadata);
  return checkoutMetadata;
}

function sanitizeThreadMetadata(value: unknown): AssistantThreadMetadata | undefined {
  if (!isRecord(value)) {
    return;
  }
  const metadata: MutableAssistantThreadMetadata = {};
  Object.assign(metadata, sanitizeCheckoutMetadata(value));
  const icon = optionalThreadIconId(value['icon']);
  const color = optionalThreadColorId(value['color']);
  const forgePrUrl = optionalString(value['forgePrUrl']);
  const forgePrWatch = optionalBoolean(value['forgePrWatch']);
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
  if (forgePrUrl) {
    metadata.forgePrUrl = forgePrUrl;
  }
  if (forgePrWatch !== undefined) {
    metadata.forgePrWatch = forgePrWatch;
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
  optionalCheckoutMode(metadata.checkoutMode);
  assertCompleteCheckoutMetadataForWrite(metadata);
  assertOptionalThreadMetadataString(metadata.checkoutBranch, 'checkout branch');
  assertOptionalThreadMetadataString(metadata.checkoutLocalRootId, 'checkout local root id');
  assertOptionalThreadMetadataString(metadata.checkoutWorktreeId, 'checkout worktree id');
  assertOptionalThreadMetadataString(metadata.checkoutWorktreePath, 'checkout worktree path');
  assertOptionalThreadMetadataString(metadata.forgePrUrl, 'forge pull request URL');
  if (metadata.forgePrWatch !== undefined && typeof metadata.forgePrWatch !== 'boolean') {
    throw new Error('Invalid assistant thread metadata forge watch flag.');
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

/** Checkout transitions are single-thread writes because their key projection is atomic. */
export function assertBulkThreadMetadataPatch(metadata: AssistantThreadMetadata): void {
  if (
    'checkoutBranch' in metadata ||
    'checkoutLocalRootId' in metadata ||
    'checkoutMode' in metadata ||
    'checkoutWorktreeId' in metadata ||
    'checkoutWorktreePath' in metadata
  ) {
    throw new Error('Bulk assistant thread metadata updates cannot change checkout state.');
  }
}

/** Test-only seam for the sanitizer — see thread-metadata.test.ts. */
export function sanitizeThreadMetadataForTest(value: unknown): AssistantThreadMetadata | undefined {
  return sanitizeThreadMetadata(value);
}

/** Test-only seam for the persistence assertion — see thread-metadata.test.ts. */
export function assertPersistableThreadMetadataForTest(metadata: AssistantThreadMetadata): void {
  assertPersistableThreadMetadata(metadata);
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
  if (
    value === 'cancelling' ||
    value === 'cancelled' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'running'
  ) {
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
  if (value === 'gateway' || value === 'hosted' || value === 'local') {
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
function readNativeDeclinedResult(invocation: Record<string, unknown>) {
  if (isDeclinedToolCallResult(invocation['result'])) {
    return invocation['result'];
  }
  const approval = invocation['approval'];
  const reason =
    isRecord(approval) && typeof approval['reason'] === 'string' ? approval['reason'] : undefined;
  return createDeclinedToolCallResult(reason);
}

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
  if (state === 'output-denied') {
    return {
      args,
      argsText: stringifyArgsText(args),
      result: readNativeDeclinedResult(inv),
      toolCallId,
      toolName: denormalizeNativeToolName(toolName),
      type: 'tool-call',
    };
  }
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

/** Scoped lifecycle events cannot precede their own persisted tool part. */
function nativeToolEventPosition(
  event: AssistantRunEvent,
  toolPositions: ReadonlyMap<string, number>
): number | undefined {
  if (
    !['tool.started', 'tool.completed', 'tool.failed'].includes(event.kind) ||
    typeof event.metadata?.['nativeMessageId'] !== 'string'
  ) {
    return;
  }
  const toolCallId = event.metadata?.['toolCallId'];
  return typeof toolCallId === 'string' ? toolPositions.get(toolCallId) : undefined;
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
  const toolPositions = new Map(
    parts.flatMap((timed, index) =>
      timed.part.type === 'tool-call' ? [[timed.part.toolCallId, index] as const] : []
    )
  );
  let eventIndex = 0;
  let lastAt = groupStartMs;
  for (const [partIndex, timed] of parts.entries()) {
    const at = timed.at ?? lastAt;
    lastAt = at;
    while (eventIndex < eventParts.length) {
      const eventPart = eventParts[eventIndex];
      if (!eventPart) {
        break;
      }
      // Scoped child streams publish tool.started after the tool part. Native
      // message/tool identity preserves that boundary when millisecond clocks tie.
      // A cancelled call may have no saved part; retain its journal event normally.
      const toolPosition = nativeToolEventPosition(eventPart.data, toolPositions);
      if (toolPosition !== undefined && toolPosition >= partIndex) {
        break;
      }
      // A terminal may follow text streamed while its tool was running. Its
      // tool boundary is a lower bound; only tool.started overrides event time.
      if (
        (toolPosition === undefined || eventPart.data.kind !== 'tool.started') &&
        runEventTimeMs(eventPart) > at
      ) {
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
        custom: {
          ...readHistoryCustomMetadata(lastRow.content),
          [NATIVE_MESSAGE_IDS_METADATA_KEY]: args.group.rows.map((row) => row.id),
        },
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

function readChildInputReceipt(message: AssistantHistoryMessage): Record<string, unknown> {
  if (!(isNativeUserSignal(message) && isRecord(message.content))) {
    return {};
  }
  const metadata = message.content['metadata'];
  if (!isRecord(metadata) || metadata['brainstrikeFollowup'] === undefined) {
    return {};
  }
  const receipt = metadata['brainstrikeFollowup'];
  if (!isRecord(receipt)) {
    throw new Error('Child input has an invalid delivery receipt.');
  }
  return {
    [CHILD_INPUT_DELIVERY_METADATA_KEY]: Schema.decodeUnknownSync(childInputDeliveryStateSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(receipt['state']),
  };
}

function appendUserHistoryMessage(args: {
  message: AssistantHistoryMessage;
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): boolean {
  const content = toTextHistoryContentParts(
    isNativeUserSignal(args.message)
      ? readContentPartArray(args.message.content)
      : args.message.content
  );
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
      metadata: { custom: readChildInputReceipt(args.message) },
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

function isNativeUserSignal(message: AssistantHistoryMessage): boolean {
  if (message.role !== 'signal' || !isRecord(message.content)) {
    return false;
  }
  const metadata = message.content['metadata'];
  if (!isRecord(metadata)) {
    return false;
  }
  const signal = metadata['signal'];
  return isRecord(signal) && signal['type'] === 'user';
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
    seenToolCallsById.clear();
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
    const role = isNativeUserSignal(message) ? 'user' : message.role;
    if (role === 'user' || role === 'system') {
      closeOpenGroup();
      units.push({ kind: role, message });
    }
    // Other roles (legacy 'tool' rows) are folded into tool results and never
    // rendered — they intentionally do not split an assistant group.
  }
  closeOpenGroup();
  return units;
}

function assignNativeMessageRunEvent(
  event: AssistantRunEvent,
  groups: ReadonlyMap<string, AssistantHistoryRowGroup>,
  assignments: Map<AssistantHistoryUnit, AssistantRunEventDataPart[]>
): boolean {
  const nativeMessageId = event.metadata?.['nativeMessageId'];
  if (typeof nativeMessageId !== 'string') {
    return false;
  }
  // Multiple host resume legs can belong to one native assistant message.
  // An id outside the loaded window must never land on an unrelated turn.
  const group = groups.get(nativeMessageId);
  if (group) {
    const parts = assignments.get(group) ?? [];
    parts.push(...toRunEventDataParts([event]));
    assignments.set(group, parts);
  }
  return true;
}

/** Background notices can split a turn into multiple topology-bearing messages.
 * Bind delegated events to the actual call within the persisted owning user turn. */
function assignDelegatedInvocationRunEvent(
  event: AssistantRunEvent,
  units: readonly AssistantHistoryUnit[],
  assignments: Map<AssistantHistoryUnit, AssistantRunEventDataPart[]>
): boolean {
  const turnMessageId = event.metadata?.['originatingTurnMessageId'];
  const toolCallId = event.metadata?.['parentToolCallId'];
  if (
    !event.kind.startsWith('subagent.') ||
    typeof turnMessageId !== 'string' ||
    typeof toolCallId !== 'string'
  ) {
    return false;
  }
  let insideTurn = false;
  const matches: AssistantHistoryRowGroup[] = [];
  for (const unit of units) {
    if (unit.kind === 'user') {
      insideTurn = unit.message.id === turnMessageId;
      continue;
    }
    if (
      unit.kind === 'assistant-group' &&
      (insideTurn || unit.rows.some((row) => row.parentId === turnMessageId)) &&
      unit.parts.some(({ part }) => part.type === 'tool-call' && part.toolCallId === toolCallId)
    ) {
      matches.push(unit);
    }
  }
  if (matches.length > 1) {
    throw new Error(
      'Delegated history event has ambiguous call ownership within its original turn.'
    );
  }
  const target = matches[0];
  if (target) {
    assignments.set(target, [...(assignments.get(target) ?? []), ...toRunEventDataParts([event])]);
  }
  // A call outside the retained history window must not attach to another turn.
  return true;
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
  const groupsByNativeMessageId = new Map(
    assistantGroups.flatMap((group) => group.rows.map((row) => [row.id, group] as const))
  );
  for (const event of runEvents) {
    if (
      assignNativeMessageRunEvent(event, groupsByNativeMessageId, assignments) ||
      assignDelegatedInvocationRunEvent(event, units, assignments)
    ) {
      continue;
    }
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
    assignments.set(candidate, [
      ...(assignments.get(candidate) ?? []),
      ...toRunEventDataParts(run.events),
    ]);
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

/** Replay the host's pre-effect rows through the ordinary history mapper. */
export function restoreDelegatedConversationHistory(
  baseline: DelegatedConversationBaseline
): Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>> {
  const history = toHistoryRepository(
    baseline.messages.map(({ parentId, ...message }) => ({
      ...message,
      createdAt: normalizeDate(message.createdAt),
      ...(parentId === undefined ? {} : { parentId }),
    })),
    baseline.runEvents
  );
  return baseline.headId === undefined ? history : { ...history, headId: baseline.headId };
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

function hasHostPauseEvidence(input: {
  readonly events: readonly AssistantRunEvent[];
  readonly hostRunId: string;
  readonly pauseKind: 'approval' | 'suspend';
  readonly toolCallId: string;
}): boolean {
  // Typed suspend has no durable pause event; its unresolved tool start is
  // the host-side evidence before native snapshot authorization.
  const expectedKind = input.pauseKind === 'approval' ? 'tool.approval.requested' : 'tool.started';
  return input.events.some(
    (event) =>
      event.runId === input.hostRunId &&
      event.kind === expectedKind &&
      event.metadata?.['toolCallId'] === input.toolCallId
  );
}

async function hasUnresolvedReplayCall(
  input: Parameters<typeof readPausedActionReplayPrefix>[0],
  hostRunId: string
): Promise<boolean> {
  if (input.delegation) {
    return (
      (await input.repository.hasPendingDelegatedToolCall?.({
        delegation: input.delegation,
        hostRunId,
        nativeRunId: input.nativeRunId,
        pauseKind: input.pauseKind,
        resourceId: input.resourceId,
        threadId: input.threadId,
        toolCallId: input.toolCallId,
      })) === true
    );
  }
  return (
    (await input.repository.hasResolvedToolCallInGeneration?.(hostRunId, input.toolCallId)) ===
    false
  );
}

/**
 * Capture the paused assistant exactly as persisted before a continuation can
 * add a new Mastra snapshot to its hydration group. A tool-call identity must
 * select one durable message; chronology is never used to choose an owner.
 */
export async function readPausedActionReplayPrefix(input: {
  readonly repository: AssistantThreadRepository;
  readonly resourceId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly nativeRunId: string;
  readonly pauseKind: 'approval' | 'suspend';
  readonly delegation?: DelegatedToolActionIdentity;
  readonly pausedMessageId?: string;
  readonly hostRunId?: string | undefined;
}): Promise<NonNullable<AssistantDiscoveredRun['actionReplay']>> {
  const { repository, resourceId, threadId, toolCallId, pausedMessageId, nativeRunId, delegation } =
    input;
  const rows = await repository.listMessages(threadId, resourceId);
  const runEvents = await repository.listThreadRunEvents(threadId, resourceId);
  const history = toHistoryRepository(rows, runEvents);
  const candidates = history.messages.filter(
    (item) =>
      item.message.role === 'assistant' &&
      item.message.content.some(
        (part) => part.type === 'tool-call' && part.toolCallId === toolCallId
      )
  );
  const syntheticIdentity = delegation
    ? getToolActionIdentityKey({ delegation, runId: nativeRunId, toolCallId })
    : `${nativeRunId}:${toolCallId}`;
  const syntheticApprovalId = `suspended-approval:${syntheticIdentity}`;
  const syntheticPauseId = `suspended-pause:${syntheticIdentity}`;
  const syntheticPauseMessageId =
    input.pauseKind === 'approval' ? syntheticApprovalId : syntheticPauseId;
  // A durable paused ID is an exact owner selector even when another native run
  // reused the same tool call ID. A synthetic notice identifies the action, not
  // the durable owner, and therefore still requires unique tool ownership.
  const hasDurablePausedId = pausedMessageId && pausedMessageId !== syntheticPauseMessageId;
  let matchingCandidates = hasDurablePausedId
    ? candidates.filter((item) => item.message.id === pausedMessageId)
    : candidates;
  if (
    hasDurablePausedId &&
    matchingCandidates.length === 0 &&
    candidates.length === 1 &&
    !rows.some((row) => row.id === pausedMessageId)
  ) {
    const candidate = candidates[0];
    const hostRunId = input.hostRunId;
    if (
      candidate &&
      hostRunId &&
      repository.getMessageParent &&
      repository.sharesNativeRunGeneration
    ) {
      const [transientParent, turnMessageId, sharesNativeRunGeneration, unresolved] =
        await Promise.all([
          repository.getMessageParent(pausedMessageId, threadId, resourceId),
          repository.getThreadRunTurnMessageId(hostRunId, threadId),
          repository.sharesNativeRunGeneration(hostRunId, nativeRunId),
          hasUnresolvedReplayCall(input, hostRunId),
        ]);
      const hasExactHostPause = hasHostPauseEvidence({
        events: runEvents,
        hostRunId,
        pauseKind: input.pauseKind,
        toolCallId,
      });
      if (
        sharesNativeRunGeneration &&
        transientParent !== undefined &&
        transientParent !== null &&
        transientParent === candidate.parentId &&
        turnMessageId === transientParent &&
        hasExactHostPause &&
        unresolved === true
      ) {
        matchingCandidates = [candidate];
      }
    }
  }
  if (matchingCandidates.length !== 1) {
    if (hasDurablePausedId && matchingCandidates.length === 0) {
      throw new Error(
        'Approval action paused assistant ID disagrees with persisted tool ownership.'
      );
    }
    throw new Error(
      `Approval action tool call ${toolCallId} has no unique durable assistant owner.`
    );
  }
  const candidate = matchingCandidates[0];
  if (candidate?.message.role !== 'assistant') {
    throw new Error('Approval action paused assistant owner disappeared.');
  }
  const prefixContent = candidate.message.content.filter(
    (part) =>
      part.type === 'text' ||
      part.type === 'reasoning' ||
      part.type === 'tool-call' ||
      part.type === 'data'
  );
  if (prefixContent.length !== candidate.message.content.length) {
    throw new Error('Approval action prefix contains an unsupported persisted part.');
  }
  return {
    pausedMessageId: candidate.message.id,
    pausedParentMessageId: candidate.parentId,
    prefixContent,
    syntheticPauseMessageId,
  };
}

export function createPgliteAssistantThreadRepository(
  database: DbHandle
): BulkAssistantThreadRepository {
  const cachedRepository = assistantThreadRepositoryCache.get(database);
  if (cachedRepository) {
    return cachedRepository;
  }
  /**
   * One probe per database handle, memoized like the bootstrap it replaced. A
   * FAILED probe drops its promise so the next call re-probes: the handle may
   * legitimately become migrated (the browser first-run bootstrap and desktop
   * main both migrate before handing a handle out, but a test — or a future
   * caller that races init — can hold one that is not migrated yet). Caching
   * the negative answer would be the same "decide once, hide forever" mistake
   * the sidecar-presence latch in `PgliteMemoryStore` avoids.
   */
  const initialize = async (): Promise<void> => {
    let probePromise = assistantThreadSchemaProbePromises.get(database);
    if (!probePromise) {
      probePromise = assertAssistantMemorySchema(database).catch((error: unknown) => {
        assistantThreadSchemaProbePromises.delete(database);
        throw error;
      });
      assistantThreadSchemaProbePromises.set(database, probePromise);
    }
    await probePromise;
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

  const listThreadRunEvents = async (
    threadId: string,
    resourceId: string,
    options?: AssistantThreadRunEventListOptions
  ): Promise<readonly AssistantRunEvent[]> => {
    await initialize();
    return readAssistantHistoryRunEvents(database, threadId, resourceId, options);
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
         WHERE id = $1 AND status NOT IN ('cancelling', 'cancelled')`,
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
      const turnMessageId = input.turnMessageId ?? null;
      const generationRunId = await resolveGenerationRunId(database, input);
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
        turnMessageId,
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
            turn_message_id,
            generation_run_id
          )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
          generationRunId,
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
        ({ table, threadColumns }) => `deleted_${table} AS (
            DELETE FROM ${table}
            WHERE (${threadColumns.map((column) => `${column} IN (SELECT id FROM deletion_threads)`).join(' OR ')})
            RETURNING 1
          )`
      ).join(',\n          ');
      const sidecarCounts = THREAD_DELETE_SIDECAR_TABLES.map(
        ({ table }) => `(SELECT count(*) FROM deleted_${table}) AS "deleted_${table}_count"`
      ).join(',\n          ');
      await database.query(
        `WITH RECURSIVE requested(id) AS (VALUES ($1::text)),
          deletion_threads AS (SELECT id FROM requested),
          deleted_observational_memory AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
            WHERE "threadId" IN (SELECT id FROM deletion_threads)
              OR "lookupKey" IN (SELECT 'thread:' || id FROM deletion_threads)
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.messages}
            WHERE thread_id IN (SELECT id FROM deletion_threads)
            RETURNING id
          ),
          ${sidecarStages},
          deleted_thread AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.threads}
            WHERE id IN (SELECT id FROM deletion_threads)
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
        [threadId]
      );
    },
    async deleteThreads(threadIds: readonly string[]): Promise<void> {
      requireAssistantThreadIds(threadIds);
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `WITH RECURSIVE requested(id) AS (
            VALUES ${threadIdValuesSql(threadIds)}
          ),
          deletion_threads AS (SELECT id FROM requested),
          validation AS (
            SELECT COUNT(threads.id) = ${threadIds.length} AS all_found
            FROM requested
            LEFT JOIN ${MASTRA_MEMORY_TABLES.threads} AS threads ON threads.id = requested.id
          ),
          deleted_observational_memory AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
            WHERE (SELECT all_found FROM validation)
              AND (
                "threadId" IN (SELECT id FROM deletion_threads)
                OR "lookupKey" IN (SELECT 'thread:' || id FROM deletion_threads)
              )
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.messages}
            WHERE (SELECT all_found FROM validation)
              AND thread_id IN (SELECT id FROM deletion_threads)
            RETURNING id
          ),
          ${THREAD_DELETE_SIDECAR_TABLES.map(
            ({ table, threadColumns }) => `deleted_${table} AS (
            DELETE FROM ${table}
            WHERE (SELECT all_found FROM validation)
              AND (${threadColumns.map((column) => `${column} IN (SELECT id FROM deletion_threads)`).join(' OR ')})
            RETURNING 1
          )`
          ).join(',\n          ')},
          deleted_threads AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.threads}
            WHERE (SELECT all_found FROM validation)
              AND id IN (SELECT id FROM deletion_threads)
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
    async getMessageParent(messageId, threadId, resourceId) {
      requireString(messageId, 'messageId');
      requireString(threadId, 'threadId');
      requireString(resourceId, 'resourceId');
      await initialize();
      const result = await database.query<{ parentId: string | null }>(
        `SELECT parent_id AS "parentId"
         FROM brainstrike_assistant_message_parents
         WHERE message_id = $1 AND thread_id = $2 AND resource_id = $3`,
        [messageId, threadId, resourceId]
      );
      return result.rows[0]?.parentId;
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
    async hasResolvedToolCallInGeneration(hostRunId, toolCallId) {
      requireString(hostRunId, 'hostRunId');
      requireString(toolCallId, 'toolCallId');
      await initialize();
      const result = await database.query<{ resolved: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM brainstrike_assistant_run_events terminal
           JOIN brainstrike_assistant_thread_runs terminal_run ON terminal_run.id = terminal.run_id
           JOIN brainstrike_assistant_thread_runs paused_run ON paused_run.id = $1
           WHERE terminal_run.thread_id = paused_run.thread_id
             AND terminal_run.resource_id = paused_run.resource_id
             AND (
               terminal.run_id = paused_run.id OR
               (paused_run.generation_run_id IS NOT NULL AND
                terminal_run.generation_run_id = paused_run.generation_run_id)
             )
             AND terminal.metadata->>'toolCallId' = $2
             AND terminal.kind IN ('tool.completed', 'tool.failed')
         ) AS resolved`,
        [hostRunId, toolCallId]
      );
      return result.rows[0]?.resolved === true;
    },
    listLatestThreadRuns,
    async listMessages(threadId, resourceId, options) {
      await initialize();
      return readAssistantHistoryMessages(database, threadId, resourceId, options);
    },
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
      await recordAssistantHistoryParent(database, { messageId, parentId, resourceId, threadId });
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
    async sharesNativeRunGeneration(hostRunId, nativeRunId) {
      requireString(hostRunId, 'hostRunId');
      requireString(nativeRunId, 'nativeRunId');
      await initialize();
      const result = await database.query<{ owns: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM brainstrike_assistant_thread_runs host
           JOIN brainstrike_assistant_native_runs mapped ON mapped.native_run_id = $2
           JOIN brainstrike_assistant_thread_runs owner ON owner.id = mapped.host_run_id
           WHERE host.id = $1
             AND host.thread_id = owner.thread_id
             AND host.resource_id = owner.resource_id
             AND (
               -- Legacy null-generation rows can still prove their exact first owner.
               mapped.host_run_id = host.id OR
               (host.generation_run_id IS NOT NULL AND
                host.generation_run_id = owner.generation_run_id)
             )
         ) AS owns`,
        [hostRunId, nativeRunId]
      );
      return result.rows[0]?.owns === true;
    },
    async updateThreadMetadata(threadId: string, metadata: AssistantThreadMetadata): Promise<void> {
      assertPersistableThreadMetadata(metadata);
      const normalized = normalizeThreadMetadataForPersistence(metadata);
      await initialize();
      // Setting any checkout mode is a checkout transition, so its branch is
      // per-checkout. Only a transition to Local also drops the three keys
      // whose authority has no meaning after the hand-off.
      const currentMetadata = metadata.checkoutMode
        ? metadata.checkoutMode === 'local'
          ? "COALESCE(metadata, '{}'::jsonb) - 'checkoutBranch' - 'checkoutWorktreeId' - 'checkoutWorktreePath' - 'checkoutLocalRootId'"
          : "COALESCE(metadata, '{}'::jsonb) - 'checkoutBranch'"
        : "COALESCE(metadata, '{}'::jsonb)";
      await database.query(
        `UPDATE ${MASTRA_MEMORY_TABLES.threads}
         SET metadata = (${currentMetadata}) || $2::jsonb
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
      // `assertBulkThreadMetadataPatch` first: it names the SPECIFIC reason
      // (checkout state is a single-thread, atomic write) for the class of
      // rejection a generic "invalid key" from the broader validator below
      // would not explain. Both run — the second stays load-bearing beyond
      // checkout keys (key whitelist, icon/color, string-shape checks).
      assertBulkThreadMetadataPatch(metadata);
      assertPersistableThreadMetadata(metadata);
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

async function loadHistoryThroughSearchTarget(
  repository: AssistantThreadRepository,
  threadId: string,
  resourceId: string,
  targetMessageId?: string,
  signal?: AbortSignal
): Promise<readonly AssistantHistoryMessage[]> {
  signal?.throwIfAborted();
  let messages = await repository.listMessages(threadId, resourceId, {
    limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    ...(targetMessageId ? { targetMessageId } : {}),
  });
  if (!targetMessageId) {
    return messages;
  }
  // Explicit search navigation pages backwards; ordinary hydration remains bounded.
  while (!messages.some((message) => message.id === targetMessageId)) {
    signal?.throwIfAborted();
    const first = messages[0];
    if (!first) {
      throw new Error('The selected message is no longer available in this conversation.');
    }
    const older = await repository.listMessages(threadId, resourceId, {
      beforeMessageId: first.id,
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
      ...(targetMessageId ? { targetMessageId } : {}),
    });
    if (older.length === 0) {
      throw new Error('The selected message is no longer available in this conversation.');
    }
    messages = [...older, ...messages];
  }
  signal?.throwIfAborted();
  return messages;
}

export function createAssistantThreadHistoryAdapter({
  repository,
  resourceId,
  threadId,
  targetMessageId,
  signal,
}: {
  /** Explicit search navigation only; ordinary hydration retains its 80-row bound. */
  readonly targetMessageId?: string;
  readonly signal?: AbortSignal;
  readonly repository: AssistantThreadRepository;
  readonly resourceId: string;
  readonly threadId: string;
}): AssistantUiThreadHistoryAdapter {
  // DURABLE-PARENT INVARIANT (BST-1243): every persisted edge must point to a
  // Mastra-persisted parent id or null. Action echoes, ordinary resume legs,
  // and rediscovered notices have no Mastra rows; alias them to their nearest
  // durable ancestor so subsequent messages cannot dangle on transient ids.
  // The narrow exception is a resumed assistant that owns a NEW pause: its
  // action echo records a proof edge from that UI id to the exact host turn,
  // allowing replay to verify the later Mastra tool owner without splitting
  // the hydrated continuation group.
  const transientParentByAliasId = new Map<string, string | null>();
  const transientResumeMessageIds = new Set<string>();
  let topologyEpoch = 0;
  const hydratedParentById = new Map<string, string | null>();
  const persistedEdgeIds = new Set<string>();

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
    const epoch = topologyEpoch;
    await repository.recordMessageParent({ messageId, parentId, resourceId, threadId });
    if (epoch === topologyEpoch) {
      persistedEdgeIds.add(messageId);
    }
  };

  // The echo is transport bookkeeping with no durable row — never an edge.
  // Its parent is the SUSPENDED assistant message, whose own runEnd append
  // never fires (assistant-ui writes a `requires-action` message only through a
  // history `update`, which this adapter deliberately does not expose), so
  // backfill that durable edge here; otherwise the reload group keys to a
  // snapshot row id and every descendant edge dangles.
  //
  // The backfill parent, in order of authority: the hydrated graph parent when
  // the suspended message was loaded; else the DURABLE HOST LEG the pause named
  // (`hostRunId`) and its `turn_message_id` (BST-1163 — every leg of a turn
  // stamps the same link, so this stays exact when other sends land during the
  // suspension and when the suspended run is a regeneration branched from an
  // older prompt).
  //
  // NEVER the marker's `runId`, and never the session tail. `runId` is the
  // NATIVE Mastra run the resume routes address: Mastra mints it
  // (`options?.runId || generateId()`), no leg passes the host id in, and one
  // host leg can hold several native runs (a background wake-up mints another),
  // so it never matched a `thread_runs` row — the lookup missed on EVERY live
  // backfill and the tail silently answered instead, guessing wrong whenever
  // the tail was not the suspended message's own turn. A live pause always
  // names its host leg; anything else is a producer defect and throws.
  const recordResumedPauseEdge = async (
    message: unknown,
    pausedMessageId: string | null,
    resolvedParentId: string | null
  ): Promise<boolean> => {
    if (!(pausedMessageId && transientResumeMessageIds.has(pausedMessageId))) {
      return false;
    }
    const epoch = topologyEpoch;
    const assertCurrent = (): void => {
      if (
        epoch !== topologyEpoch ||
        !transientResumeMessageIds.has(pausedMessageId) ||
        transientParentByAliasId.get(pausedMessageId) !== resolvedParentId
      ) {
        throw new Error('Assistant resumed pause changed while its parent was loading.');
      }
    };
    const hostRunId = readActionMessageHostRunId(message);
    if (!hostRunId) {
      throw new Error('Assistant history cannot anchor a resumed pause without its host leg.');
    }
    const turnMessageId = await repository.getThreadRunTurnMessageId(hostRunId, threadId);
    const resolvedParent =
      resolvedParentId && repository.getMessageParent
        ? await repository.getMessageParent(resolvedParentId, threadId, resourceId)
        : undefined;
    assertCurrent();
    if (
      !(turnMessageId && (resolvedParentId === turnMessageId || resolvedParent === turnMessageId))
    ) {
      throw new Error('Assistant resumed pause disagrees with its durable host turn.');
    }
    if (persistedEdgeIds.has(pausedMessageId)) {
      const existingParent = await repository.getMessageParent?.(
        pausedMessageId,
        threadId,
        resourceId
      );
      assertCurrent();
      if (existingParent !== turnMessageId) {
        throw new Error('Assistant resumed pause has a conflicting persisted parent.');
      }
    } else {
      await recordParentEdge(pausedMessageId, turnMessageId);
      assertCurrent();
    }
    return true;
  };

  const recordActionEchoAppend = async (
    message: unknown,
    pausedMessageId: string | null,
    resolvedParentId: string | null
  ): Promise<void> => {
    if (await recordResumedPauseEdge(message, pausedMessageId, resolvedParentId)) {
      return;
    }
    if (resolvedParentId === null || persistedEdgeIds.has(resolvedParentId)) {
      return;
    }
    if (hydratedParentById.has(resolvedParentId)) {
      await recordParentEdge(resolvedParentId, hydratedParentById.get(resolvedParentId) ?? null);
      return;
    }
    const hostRunId = readActionMessageHostRunId(message);
    if (!hostRunId) {
      throw new Error(
        `Assistant history cannot anchor suspended message ${resolvedParentId}: its pause named no durable host leg.`
      );
    }
    const turnMessageId = await repository.getThreadRunTurnMessageId(hostRunId, threadId);
    // An approval on a still-streaming leg aborts that leg, and its terminal
    // runEnd append can persist the suspended message's own edge while this
    // lookup is pending. That edge is authoritative, so session state read
    // across the await is re-validated, never trusted (PR #3201).
    if (persistedEdgeIds.has(resolvedParentId)) {
      return;
    }
    // Truthiness, matching the `!hostRunId` guard above: a blank or absent
    // anchor is as unusable as a missing one and must never reach an edge.
    if (!turnMessageId) {
      throw new Error(
        `Assistant history cannot anchor suspended message ${resolvedParentId}: host leg ${hostRunId} records no turn message.`
      );
    }
    await recordParentEdge(resolvedParentId, turnMessageId);
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
        const appendEpoch = topologyEpoch;
        // assistant-ui keeps the optimistic echo even when the async history
        // write rejects. Its descendants still need the durable parent alias.
        transientParentByAliasId.set(item.message.id, resolvedParentId);
        const pausedOwnerId = readActionMessagePausedOwnerId(item.message) ?? item.parentId;
        const resolvedPausedOwnerId = resolveDurableParentId(pausedOwnerId);
        await recordActionEchoAppend(item.message, pausedOwnerId, resolvedPausedOwnerId);
        if (appendEpoch !== topologyEpoch) {
          throw new Error('Assistant approval action changed while its parent was loading.');
        }
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
        transientResumeMessageIds.add(item.message.id);
        return;
      }
      await recordParentEdge(item.message.id, resolvedParentId);
    },
    async load() {
      topologyEpoch += 1;
      const [messages, runEvents] = await Promise.all([
        loadHistoryThroughSearchTarget(repository, threadId, resourceId, targetMessageId, signal),
        repository.listThreadRunEvents(threadId, resourceId, {
          limitLatestRuns: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
        }),
      ]);
      // Reseed session topology state from hydration (a re-load replaces it).
      transientParentByAliasId.clear();
      transientResumeMessageIds.clear();
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
      return base;
    },
  };
}

export { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
