import { ASSISTANT_RUN_USAGE_KINDS } from '@brainstrike/assistant-contract/run-usage';
import { z } from 'zod';
import {
  RunVerdictDetailSchema,
  RunVerdictSchema,
  RunVerdictSourceSchema,
} from './run-verdict-wire.js';

const Id = z.string().min(1);
const Seq = z.number().int().nonnegative();
/** A committed row time, in ms since the epoch. */
const CommitTime = z.number().int().nonnegative();
const Tokens = z.number().int().nonnegative();
/** A run as the thread badges and the Task Ledger read it: Stop is cancelled, an interruption failed. */
const LedgerRunStatus = z.enum(['running', 'completed', 'failed', 'cancelled']);

/** A thread's latest root run, folded from its committed log. */
export const HostLatestRunSchema = z.strictObject({
  /** The run.finished row's commit time; null while the run is open. */
  completedAt: CommitTime.nullable(),
  /** An approval, question, plan or network consent waits on its user. */
  needsInput: z.boolean(),
  /** The committed row that last changed it: of two reads, a reader keeps the later. */
  seq: Seq,
  status: LedgerRunStatus,
});
export type HostLatestRun = z.infer<typeof HostLatestRunSchema>;

/**
 * One thread's share of the cost views, as Core folds its committed log: the
 * legacy RunLedgerRow, cross-root usage and thread usage shapes, with commit
 * times in ms. The host records no provider-billed cost, so every token is an
 * estimate.
 */
export const HostLedgerThreadSchema = z.strictObject({
  /** Per (provider, model, source) subtotals: the meter's thread total. */
  perModel: z.array(
    z.strictObject({
      cacheCreationTokens: Tokens,
      cacheReadTokens: Tokens,
      estimatedCacheCreationTokens: Tokens,
      estimatedCacheReadTokens: Tokens,
      estimatedInputTokens: Tokens,
      estimatedOutputTokens: Tokens,
      inputTokens: Tokens,
      model: z.string(),
      outputTokens: Tokens,
      provider: Id,
      runKind: z.enum(ASSISTANT_RUN_USAGE_KINDS),
    })
  ),
  /** Per (root, provider, model) subtotals; a null root is a run bound to none. */
  rootUsage: z.array(
    z.strictObject({
      estimatedCacheCreationTokens: Tokens,
      estimatedCacheReadTokens: Tokens,
      estimatedInputTokens: Tokens,
      estimatedOutputTokens: Tokens,
      inputTokens: Tokens,
      model: z.string(),
      outputTokens: Tokens,
      provider: Id,
      rootDisplayName: z.string().nullable(),
      rootId: Id.nullable(),
    })
  ),
  runs: z.array(
    z.strictObject({
      completedAt: CommitTime.nullable(),
      durationMs: z.number().int().nullable(),
      editCount: Tokens,
      estimatedCacheCreationTokens: Tokens,
      estimatedCacheReadTokens: Tokens,
      estimatedInputTokens: Tokens,
      estimatedOutputTokens: Tokens,
      failedToolCallCount: Tokens,
      inputTokens: Tokens,
      model: z.string(),
      // Effective label from the same committed run.verdict events as the conversation.
      outcomeDetail: RunVerdictDetailSchema.nullable(),
      outcomeSource: RunVerdictSourceSchema.nullable(),
      outcomeVerdict: RunVerdictSchema.nullable(),
      outputTokens: Tokens,
      provider: Id,
      revertedEditCount: Tokens,
      runId: Id,
      startedAt: CommitTime,
      status: LedgerRunStatus,
      threadId: Id,
      toolCallCount: Tokens,
    })
  ),
  /** The last committed row folded: of two reads, a reader keeps the later. */
  seq: Seq,
  threadId: Id,
  /** One record per costed provider call, at its commit time. */
  usage: z.array(
    z.strictObject({
      at: CommitTime,
      cacheReadTokens: Tokens,
      cacheWriteTokens: Tokens,
      inputTokens: Tokens,
      model: z.string(),
      outputTokens: Tokens,
      provider: Id,
    })
  ),
});
export type HostLedgerThread = z.infer<typeof HostLedgerThreadSchema>;
