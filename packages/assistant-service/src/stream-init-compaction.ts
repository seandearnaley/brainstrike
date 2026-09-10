import type { AgentMessage, RuntimeData, StreamChunk } from '@brainstrike/agent';
import {
  boundRunEventReason,
  createAssistantRunEvent,
} from '@brainstrike/assistant-contract/run-events';
import type { AssistantChildRunUsage } from '@brainstrike/assistant-contract/run-usage';
import type { ScopedLogger } from '@brainstrike/logging';
import type {
  AgentStreamCapabilities,
  AgentStreamCapabilityKinds,
  AgentStreamMemoryResult,
} from './stream-init.js';

// Extracted from stream-init.ts (BST-1200 milestone 2 review response, item 6
// / max-file-lines gate) — the pre-request compaction trigger and its stream
// prelude, with no behavior change from the original inline definitions.
// BST-1737 added the failure breadcrumb to that same prelude. Kept as its own
// module because it is the one cohesive,
// independently testable slice of stream-init.ts's request-init flow: it
// owns exactly the "should we compact before this turn's stream starts, and
// how does that surface as a stream chunk" concern, importing only the
// capability/runtime types it needs from the root module.

export interface PreRequestCompactionCapabilityResult {
  readonly kind: 'agentic' | 'deterministic' | 'noop';
  readonly usage?: AssistantChildRunUsage;
}

/**
 * BST-1737's breadcrumb together with the latch commit that belongs to it.
 *
 * ONE value rather than two sibling fields, because the commit is only ever
 * correct AFTER `chunk` has actually been handed downstream. Binding them makes
 * the halves inseparable: a caller cannot emit the row without holding the
 * latch, and cannot latch without having emitted the row.
 */
export interface PreRequestCompactionFailureBreadcrumb {
  readonly chunk: StreamChunk;
  /**
   * Commits the (thread, reason) latch. Idempotent — it adds to a `Set`, so
   * calling it more than once changes nothing.
   */
  readonly markReported: () => void;
}

/**
 * What the pre-request pass produced for THIS turn's stream prelude.
 *
 * Both fields are optional and, in practice, mutually exclusive: a pass that
 * threw returns no usage, and a pass that succeeded mints no breadcrumb. The
 * shape is a record rather than a union so the caller stays a single
 * `withCompactionPreludeChunks` call — the failure signal must ride the same
 * prelude the usage chunk already rides, not a second seam the next refactor
 * can drop.
 */
export interface PreRequestCompactionOutcome {
  /**
   * BST-1737's always-visible `compaction.failed` breadcrumb, minted when the
   * pass threw AND the (thread, reason) latch below has not already reported
   * it. Undefined on success, on a cancelled turn, and on a repeat.
   */
  readonly failure?: PreRequestCompactionFailureBreadcrumb;
  readonly result?: PreRequestCompactionCapabilityResult;
}

const COMPACTION_FAILURE_RUN_EVENT_KIND = 'compaction.failed' as const;

/**
 * BST-1737: latches the visible breadcrumb to once per (thread, reason) for the
 * life of this process.
 *
 * WHY LATCHED AT ALL. Most of what can reach this catch is STICKY — an unknown
 * model, a malformed `agentLoop.inputTokenLimit`, a missing trusted overlay
 * lookup — and fails identically on every turn of the thread. Unlatched, a
 * thread in that steady state would grow one identical always-visible row per
 * turn forever, pushing real content out of the timeline; the row would then
 * be ignored, which is the same silence in a louder costume.
 *
 * WHY KEYED ON THE REASON, not the thread alone. The latch must never be able
 * to hide a DIFFERENT failure — that would recreate this ticket inside its own
 * fix. A new cause on an already-reported thread still gets its own row.
 *
 * WHAT IS NOT LATCHED. The `warn` log fires on every single failing turn, so
 * per-turn operator evidence is never lost; only the user-facing row is
 * deduplicated.
 *
 * WHEN THE KEY IS ADDED. Only once the breadcrumb has been handed to the
 * stream's consumer — see `markReported` and `prependStreamChunks`. Latching at
 * mint time was wrong (Codex review of #3119): minting happens while the
 * outcome is still being CONSTRUCTED, before `initializeAgentStream` awaits
 * `resolveInitialAgentStream` (packages/assistant-service/src/stream-init.ts).
 * If that await rejects — or the returned stream is never consumed — the row
 * reaches neither `observe()` nor persistence, yet every later turn with the
 * same thread and reason would be suppressed for the life of the process. That
 * is exactly the silent degradation this ticket exists to remove, reappearing
 * inside its own fix. Handing the chunk to the consumer is NOT proof it was
 * persisted or rendered — a wrapper further out could still drop it — but it
 * closes by far the widest part of that window, and the residue costs at most
 * one thread's repeat row rather than a permanent process-wide silence.
 *
 * Intentionally in-memory only (no persistence, no eviction), mirroring
 * `warnedBaselineExceedsTargetThreadIds` in
 * apps/desktop/src/assistant-server/conversation-compaction.ts: a restart
 * re-arms it, and the set is bounded by real thread cardinality times distinct
 * failure reasons, not by request volume — EXCEPT where the reason embeds a
 * per-message id (`Compaction candidate <id> has no valid creation time.`,
 * `Assistant message <id> has conflicting branch topology.`), which neither
 * deduplicates nor stays bounded and grows one entry per failing turn. See
 * KNOWN LIMIT OF THE KEYING in docs/agents/assistant-persistence.md; do not
 * re-derive the unqualified bound from this comment.
 */
const reportedCompactionFailures = new Set<string>();

/**
 * The commit for a breadcrumb that is deliberately NOT latched. Deliberately
 * empty: an unidentified thread reports on every failing turn.
 */
const NEVER_LATCHED = (): void => {
  return;
};

function compactionFailureRunEventChunk(reason: string): StreamChunk {
  return {
    event: createAssistantRunEvent({
      detail: `This turn was sent without pre-request compaction — ${reason}`,
      kind: COMPACTION_FAILURE_RUN_EVENT_KIND,
      label: 'Conversation compaction unavailable',
      metadata: { reason },
      status: 'failed',
    }),
    type: 'run-event',
  };
}

function compactionFailureChunk(input: {
  readonly error: unknown;
  readonly threadId: string | undefined;
}): PreRequestCompactionFailureBreadcrumb | undefined {
  // Redacted and length-bounded because this string becomes DURABLE run-event
  // metadata and a rendered row: compaction failures quote provider/model and
  // can carry transport or DB detail.
  const reason = boundRunEventReason(input.error);
  const threadId = input.threadId;
  if (!threadId) {
    // NO THREAD ID, NO LATCH. Keying every unidentified turn under one shared
    // bucket would let a single delivered row permanently silence a DIFFERENT
    // conversation failing the same way — the one thing this latch must never
    // do, in exactly the case where it knows least. Report every time instead.
    return { chunk: compactionFailureRunEventChunk(reason), markReported: NEVER_LATCHED };
  }
  // LENGTH-FRAMED, not delimited: unambiguous for any thread id and reason
  // without depending on some character being impossible in either. It was a
  // NUL separator until #3119's own review quoted this line and reproduced that
  // byte, which `execFileSync` refuses in an argv string — see
  // docs/agents/assistant-persistence.md. A key that never leaves this `Set`
  // must carry nothing the rest of the toolchain cannot transport.
  const key = `${threadId.length}:${threadId}${reason}`;
  if (reportedCompactionFailures.has(key)) {
    return;
  }
  // The key is READ here and COMMITTED on delivery. Two turns that fail
  // identically before either prelude is consumed therefore both mint a row,
  // which is honest — both turns really were sent uncompacted — and is the only
  // direction that cannot suppress a row nobody ever saw.
  return {
    chunk: compactionFailureRunEventChunk(reason),
    markReported: () => {
      reportedCompactionFailures.add(key);
    },
  };
}

interface PreludeChunk {
  readonly chunk: StreamChunk;
  /**
   * Runs after the consumer has taken `chunk` AND come back for the next one,
   * so it fires only for a prelude that was genuinely drained: a stream that is
   * never consumed never runs the generator body at all, and a consumer that
   * abandons the iterator mid-prelude resumes it with a return completion that
   * skips this call rather than falling through to it.
   */
  readonly onDelivered?: () => void;
}

async function* prependStreamChunks(
  prelude: readonly PreludeChunk[],
  source: AsyncIterable<StreamChunk>
): AsyncIterable<StreamChunk> {
  for (const entry of prelude) {
    yield entry.chunk;
    entry.onDelivered?.();
  }
  yield* source;
}

export async function runConversationCompactionBeforeStream<
  K extends AgentStreamCapabilityKinds,
>(input: {
  readonly capabilities: AgentStreamCapabilities<K>;
  readonly logger: ScopedLogger;
  readonly memoryResult: AgentStreamMemoryResult | undefined;
  readonly messages: readonly AgentMessage[];
  readonly runId: string | undefined;
  readonly runtime: RuntimeData;
  readonly signal: AbortSignal;
}): Promise<PreRequestCompactionOutcome> {
  if (!input.memoryResult) {
    return {};
  }
  input.runtime.contextOverflowRecovery =
    input.capabilities.compaction.createContextOverflowRecovery({
      memoryStore: input.memoryResult.store,
      runtimeData: input.runtime,
    });
  try {
    return {
      result: await input.capabilities.compaction.runPreRequest({
        memoryStore: input.memoryResult.store,
        requestMessages: input.messages,
        runId: input.runId,
        runtimeData: input.runtime,
        signal: input.signal,
      }),
    };
  } catch (error) {
    // The turn SURVIVES — degrading gracefully here is correct, and a
    // compaction failure must never kill the user's turn. What BST-1737 fixes
    // is that it used to degrade INVISIBLY: this warn was the only evidence,
    // and the user's next symptom was a provider context-overflow error naming
    // an unrelated cause.
    input.logger.warn('Pre-request conversation compaction failed; continuing the user turn.', {
      code: 'conversation_compaction_pre_request_failed',
      error,
    });
    if (input.signal.aborted) {
      // A cancelled turn is not a degraded one: `run.cancelled` already reports
      // it, and a "compaction unavailable" row here would be a false alarm on
      // every cancellation that lands mid-pass.
      return {};
    }
    const failure = compactionFailureChunk({
      error,
      threadId: input.runtime.memory?.threadId,
    });
    return failure ? { failure } : {};
  }
}

/**
 * Everything the pre-request pass contributes to the FRONT of this turn's
 * stream: BST-1737's failure breadcrumb first (it describes the turn the user
 * is about to read), then the compaction summary's `child-run-usage`.
 *
 * Returns `source` by identity when there is nothing to prepend, so the common
 * path allocates no wrapper generator.
 */
export function withCompactionPreludeChunks(
  source: AsyncIterable<StreamChunk>,
  outcome: PreRequestCompactionOutcome
): AsyncIterable<StreamChunk> {
  const prelude: PreludeChunk[] = [];
  if (outcome.failure) {
    // The latch commit travels WITH the chunk, so the row cannot be emitted
    // without arming the latch, nor the latch armed without emitting the row.
    prelude.push({
      chunk: outcome.failure.chunk,
      onDelivered: outcome.failure.markReported,
    });
  }
  if (outcome.result?.usage) {
    prelude.push({ chunk: { type: 'child-run-usage', value: outcome.result.usage } });
  }
  if (prelude.length === 0) {
    return source;
  }
  return prependStreamChunks(prelude, source);
}

export function trustedCompactionOverlayFields(
  lookup: RuntimeData['compactionOverlayLookup']
): Pick<RuntimeData, 'compactionOverlayLookup'> {
  return lookup ? { compactionOverlayLookup: lookup } : {};
}
