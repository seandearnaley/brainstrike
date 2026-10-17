import { ASSISTANT_RUN_USAGE_KINDS } from '@brainstrike/assistant-contract/run-usage';
import { Schema } from 'effect';
import {
  RunVerdictDetailSchema,
  RunVerdictSchema,
  RunVerdictSourceSchema,
} from './run-verdict-wire.js';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** A committed row time, in ms since the epoch. */
const CommitTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** A run as the thread badges and the Task Ledger read it: Stop is cancelled, an interruption failed. */
const LedgerRunStatus = Schema.Literals(['running', 'completed', 'failed', 'cancelled']);
/** A thread's latest root run, folded from its committed log. */
export const HostLatestRunSchema = Schema.Struct({
  completedAt: Schema.NullOr(CommitTime),
  needsInput: Schema.Boolean,
  seq: Seq,
  status: LedgerRunStatus,
});
export type HostLatestRun = (typeof HostLatestRunSchema)['Type'];
/**
 * One thread's share of the cost views, as Core folds its committed log: the
 * legacy RunLedgerRow, cross-root usage and thread usage shapes, with commit
 * times in ms. The host records no provider-billed cost, so every token is an
 * estimate.
 */
export const HostLedgerThreadSchema = Schema.Struct({
  perModel: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        cacheCreationTokens: Tokens,
        cacheReadTokens: Tokens,
        estimatedCacheCreationTokens: Tokens,
        estimatedCacheReadTokens: Tokens,
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
        estimatedCacheCreationTokens: Tokens,
        estimatedCacheReadTokens: Tokens,
        estimatedInputTokens: Tokens,
        estimatedOutputTokens: Tokens,
        inputTokens: Tokens,
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
        completedAt: Schema.NullOr(CommitTime),
        durationMs: Schema.NullOr(Schema.Int),
        editCount: Tokens,
        estimatedCacheCreationTokens: Tokens,
        estimatedCacheReadTokens: Tokens,
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
      })
    )
  ),
  seq: Seq,
  threadId: Id,
  usage: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        at: CommitTime,
        cacheReadTokens: Tokens,
        cacheWriteTokens: Tokens,
        inputTokens: Tokens,
        model: Schema.String,
        outputTokens: Tokens,
        provider: Id,
      })
    )
  ),
});
export type HostLedgerThread = (typeof HostLedgerThreadSchema)['Type'];
