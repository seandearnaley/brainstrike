import type {
  AssistantUiThreadHistoryAdapter,
  DelegatedConversationBaseline,
} from '@brainstrike/assistant-contract';
import {
  CHILD_INPUT_DELIVERY_METADATA_KEY,
  childInputDeliveryStateSchema,
  isGuardedToolError,
  NATIVE_MESSAGE_IDS_METADATA_KEY,
} from '@brainstrike/assistant-contract';
import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type AssistantRunEvent,
} from '@brainstrike/assistant-contract/run-events';
import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';
import {
  createDeclinedToolCallResult,
  isDeclinedToolCallResult,
} from '@brainstrike/assistant-contract/tool-approval';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import type {
  AssistantHistoryMessage,
  AssistantThreadMessageListOptions,
  AssistantThreadRunEventListOptions,
} from '@brainstrike/db';
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

import type { AssistantThreadIconId } from '@brainstrike/types';

export { ASSISTANT_THREAD_ICON_IDS, type AssistantThreadIconId } from '@brainstrike/types';
export { ASSISTANT_THREAD_COLOR_IDS } from './assistant-thread-palette.js';

import type { AssistantThreadColorId } from './assistant-thread-palette.js';

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

export interface RecordAssistantMessageParentInput {
  readonly messageId: string;
  readonly parentId: string | null;
  readonly resourceId: string;
  readonly threadId: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

export { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
