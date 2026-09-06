import type { AssistantEditCheckpointRecord } from '@brainstrike/assistant-contract';
import type { AssistantRunEvent } from '@brainstrike/assistant-contract/run-events';
import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';

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

export type MutableAssistantThreadMetadata = {
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

/**
 * The assistant thread repository seam. EVERY method is required (BST-1651).
 *
 * Six of them used to be optional, marked "only for read-only/test
 * repositories" — but there has only ever been ONE implementation, and it has
 * all of them. The optionality described test doubles, not reality, and it cost
 * real behavior: `use-edit-checkpoints` and `use-run-verdict` each gated a user-
 * visible feature on `if (!repository.recordRunOutcome)`, so a shape error
 * upstream would have silently removed the verdict affordance instead of
 * failing. That is the silent-degradation shape this codebase forbids.
 *
 * Partial test doubles cast through `as unknown as AssistantThreadRepository`,
 * which states plainly that a fake is partial; a fake that wants to be complete
 * is complete. `AssistantThreadRepository` — the old "same interface, four
 * methods un-optionalized" companion — is gone with the optionality that
 * created it; it had no consumer outside this module.
 */
export interface AssistantThreadRepository {
  appendThreadRunEvent: (runId: string, event: AssistantRunEvent) => Promise<void>;
  completeThreadRun: (runId: string, input: CompleteAssistantThreadRunInput) => Promise<void>;
  createThread: (resourceId: string, title?: string) => Promise<AssistantMemoryThread>;
  createThreadRun: (input: CreateAssistantThreadRunInput) => Promise<AssistantThreadRunRecord>;
  deleteThread: (threadId: string) => Promise<void>;
  deleteThreads: (threadIds: readonly string[]) => Promise<void>;
  getCrossRootUsage: (resourceId: string) => Promise<readonly CrossRootUsageRow[]>;
  /** Task Ledger read model. */
  getRunLedger: (
    resourceId: string,
    options?: RunLedgerListOptions
  ) => Promise<readonly RunLedgerRow[]>;
  getThreadCumulativeUsage: (threadId: string) => Promise<ThreadCumulativeUsage | null>;
  /**
   * BST-1163 run↔turn link, read by the history adapter's suspended-edge
   * backfill (BST-1243).
   */
  getThreadRunTurnMessageId: (runId: string, threadId: string) => Promise<string | null>;
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
  /** Required by history-adapter append. */
  recordMessageParent: (input: RecordAssistantMessageParentInput) => Promise<void>;
  /** Task Ledger: upsert the per-run outcome label. */
  recordRunOutcome: (input: RecordRunOutcomeInput) => Promise<void>;
  recordRunUsage: (input: RecordRunUsageInput) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  updateThreadMetadata: (threadId: string, metadata: AssistantThreadMetadata) => Promise<void>;
  updateThreadsMetadata: (
    threadIds: readonly string[],
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
}

export interface AssistantHistoryMessage {
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
