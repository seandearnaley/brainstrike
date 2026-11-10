import { ASSISTANT_RUN_USAGE_KINDS } from '@brainstrike/assistant-contract/run-usage';
import { Schema } from 'effect';
import {
  RunVerdictDetailSchema,
  RunVerdictSchema,
  RunVerdictSourceSchema,
} from './run-verdict-wire.ts';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** A committed row time, in ms since the epoch. */
const CommitTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * List-price USD, each call priced on its own and then summed; null when any
 * call in the total has no registry price.
 */
const CostUsd = Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)));
/** What the provider billed for the total's billed calls; absent when it billed none. */
const BilledCostUsd = Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)));
/** A run as the thread badges and the Task Ledger read it: Stop is cancelled, an interruption failed. */
const LedgerRunStatus = Schema.Literals(['running', 'completed', 'failed', 'cancelled']);
/** A thread's latest root run, folded from its committed log. */
export const HostLatestRunSchema = Schema.Struct({
  completedAt: Schema.NullOr(CommitTime),
  needsInput: Schema.Boolean,
  seq: Seq,
  /** When the run started: the thread's latest conversation activity while it runs. */
  startedAt: Schema.NullOr(CommitTime),
  status: LedgerRunStatus,
});
export type HostLatestRun = (typeof HostLatestRunSchema)['Type'];
/**
 * One thread's share of the cost views, as Core folds its committed log: the
 * legacy RunLedgerRow, cross-root usage and thread usage shapes, with commit
 * times in ms. A call the provider billed counts in `billedCostUsd`; the
 * `estimated*` fields cover only the rest, priced from the catalog.
 */
export const HostLedgerThreadSchema = Schema.Struct({
  perModel: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        billedCostUsd: BilledCostUsd,
        cacheCreationTokens: Tokens,
        cacheReadTokens: Tokens,
        /** What caching saved these calls; absent without cache traffic. */
        cacheSavingsUsd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        estimatedCostUsd: CostUsd,
        estimatedInputTokens: Tokens,
        estimatedOutputTokens: Tokens,
        inputTokens: Tokens,
        model: Schema.String,
        outputTokens: Tokens,
        provider: Id,
        runKind: Schema.Literals(ASSISTANT_RUN_USAGE_KINDS),
      })
    )
  ),
  rootUsage: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        billedCostUsd: BilledCostUsd,
        /** The branch the run's thread had checked out at Send; null when unrecorded. */
        checkoutBranch: Schema.NullOr(Id),
        estimatedCostUsd: CostUsd,
        estimatedInputTokens: Tokens,
        estimatedOutputTokens: Tokens,
        inputTokens: Tokens,
        /** A worktree root's repository (its Local root); null outside a worktree. */
        localRootId: Schema.NullOr(Id),
        model: Schema.String,
        outputTokens: Tokens,
        provider: Id,
        rootDisplayName: Schema.NullOr(Schema.String),
        rootId: Schema.NullOr(Id),
      })
    )
  ),
  runs: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        billedCostUsd: BilledCostUsd,
        /** Every call's prompt-cache tokens, billed or estimated. */
        cacheCreationTokens: Tokens,
        cacheReadTokens: Tokens,
        completedAt: Schema.NullOr(CommitTime),
        durationMs: Schema.NullOr(Schema.Int),
        editCount: Tokens,
        estimatedCostUsd: CostUsd,
        estimatedInputTokens: Tokens,
        estimatedOutputTokens: Tokens,
        failedToolCallCount: Tokens,
        inputTokens: Tokens,
        model: Schema.String,
        outcomeDetail: Schema.NullOr(RunVerdictDetailSchema),
        outcomeSource: Schema.NullOr(RunVerdictSourceSchema),
        outcomeVerdict: Schema.NullOr(RunVerdictSchema),
        outputTokens: Tokens,
        provider: Id,
        revertedEditCount: Tokens,
        runId: Id,
        startedAt: CommitTime,
        status: LedgerRunStatus,
        threadId: Id,
        toolCallCount: Tokens,
        /** Cut-off calls the provider bills but never reported: not $0, not estimated. */
        unreportedCallCount: Tokens,
      })
    )
  ),
  seq: Seq,
  threadId: Id,
  usage: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        at: CommitTime,
        billedCostUsd: BilledCostUsd,
        cacheReadTokens: Tokens,
        cacheWriteTokens: Tokens,
        costUsd: CostUsd,
        inputTokens: Tokens,
        model: Schema.String,
        outputTokens: Tokens,
        provider: Id,
      })
    )
  ),
});
export type HostLedgerThread = (typeof HostLedgerThreadSchema)['Type'];
