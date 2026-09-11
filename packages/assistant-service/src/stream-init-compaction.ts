import { createHash } from 'node:crypto';
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
   * Commits the (thread, shape) latch. Idempotent by an explicit guard in
   * `latchCompactionFailure`, NOT merely because a `Set` ignores a repeat
   * `add` — that stopped being sufficient when BST-1744 capped the set, since
   * a commit that added nothing would still have evicted the oldest entry.
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
   * pass threw AND the (thread, shape) latch below has not already reported
   * it. Undefined on success, on a cancelled turn, and on a repeat.
   */
  readonly failure?: PreRequestCompactionFailureBreadcrumb;
  readonly result?: PreRequestCompactionCapabilityResult;
}

const COMPACTION_FAILURE_RUN_EVENT_KIND = 'compaction.failed' as const;

/**
 * BST-1737: latches the visible breadcrumb to once per (thread, reason-shape)
 * for the life of this process.
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
 * fix. A new cause on an already-reported thread still gets its own row. Since
 * BST-1744 the key is the reason's SHAPE rather than its literal text, which
 * merges only what the masking positively recognises as the same throw — see
 * `compactionFailureKey`.
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
 * Intentionally in-memory only (no persistence), mirroring
 * `warnedBaselineExceedsTargetThreadIds` in
 * apps/desktop/src/assistant-server/conversation-compaction.ts: a restart
 * re-arms it. BST-1744 replaced #3119's unqualified "no eviction" with a real
 * bound, because keying on the whole bounded reason left the two id-bearing
 * throws deduplicating nothing and growing an entry per failing turn: the key
 * is now a fixed-width digest of the throw's SHAPE (`compactionFailureKey`)
 * and the set is capped by `latchCompactionFailure`. BOTH halves were needed —
 * shaping cannot be proven complete against a free-form `TEXT` message id, and
 * a cap alone would have left a wedged thread minting a row every turn. See
 * THE KEY IS THE SHAPE OF THE THROW in docs/agents/assistant-persistence.md.
 */
const reportedCompactionFailures = new Set<string>();

/**
 * BST-1744: the hard ceiling on `reportedCompactionFailures`.
 *
 * The masking in `compactionFailureKey` cannot be proven complete —
 * `mastra_messages.id` is free-form `TEXT` (migration 117), so a thread wedged
 * on an id in some unrecognised shape still mints a fresh key every turn. This
 * cap is therefore the ONLY component that bounds the set without assuming the
 * masking caught everything, which is why BST-1744 took both halves and not
 * whichever one looked sufficient on its own.
 *
 * 512 fixed-width entries is a few tens of KB — far below anything worth
 * evicting for on a healthy process, and small enough that a pathological one
 * cannot grow this without limit.
 */
export const MAX_TRACKED_COMPACTION_FAILURES = 512;

/**
 * Commits one key, evicting the OLDEST first-seen entry at the cap.
 *
 * Drop-oldest, not least-recently-used: the dedupe fast path only READS the
 * set, so recency would have to be written on every suppressed turn, and
 * first-seen order is already exact because a key present in the set is never
 * re-added. Eviction costs the evicted failure ONE more visible row if it
 * recurs — a repeat row, never a silence, which is the direction every other
 * ruling on this latch picks.
 *
 * The early return is load-bearing, not just a fast path: `markReported` is
 * documented idempotent, and two turns that fail identically before either
 * prelude is consumed both mint and both commit. Without it the second commit
 * would evict the oldest entry while adding nothing.
 */
function latchCompactionFailure(key: string): void {
  if (reportedCompactionFailures.has(key)) {
    return;
  }
  if (reportedCompactionFailures.size >= MAX_TRACKED_COMPACTION_FAILURES) {
    const oldest = reportedCompactionFailures.values().next();
    if (!oldest.done) {
      reportedCompactionFailures.delete(oldest.value);
    }
  }
  reportedCompactionFailures.add(key);
}

/**
 * BST-1744: tokens that differ between two occurrences of the SAME failure.
 *
 * This is deliberately NOT the classifier the `compaction.failed` kind refused
 * (see ONE KIND, REASON IN THE ROW): there is no registry of known throws to
 * extend, and an unrecognised throw is never bucketed into an "other" — it
 * simply keys on its own text. The masking therefore fails in ONE direction
 * only, by UNDER-merging: the worst it can do is mint an extra visible row,
 * never suppress a real second failure.
 *
 * Both patterns are evidence-backed rather than speculative. Ids, because the
 * two reachable throws that embed one take it from `randomUUID`
 * (apps/desktop/src/assistant-server/conversation-compaction.ts,
 * packages/assistant-data/src/assistant-memory-repository.ts). Timestamps,
 * because the compaction fixture in `run-events.test.ts` quotes a creation
 * time, and a driver error that does so changes on every turn.
 *
 * SHORT DIGIT RUNS ARE NOT VOLATILE, deliberately. `ollama/llama3.2` and
 * `ollama/llama3.3` are DIFFERENT failures, and a blanket digit mask would let
 * the first permanently silence the second — the one thing this latch must
 * never do. `mastra_messages.id` is free-form `TEXT`, so an id in some other
 * shape still defeats the de-duplication; that residue is bounded by
 * MAX_TRACKED_COMPACTION_FAILURES above rather than by widening these patterns
 * until they start merging distinct failures.
 */
const VOLATILE_TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const VOLATILE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The latch key for one failure, as `<threadId.length>:<threadId><digest>`.
 *
 * Built from the UNTRUNCATED message, never from the rendered reason. The
 * rendered reason is bounded to 200 code points, so a key built from it
 * collapses two failures that agree on their first 199 characters onto one
 * entry and lets the first silence the second. Hashing the shape is what makes
 * an untruncated key affordable: the digest is fixed-width, so the capped set
 * below is a real BYTE bound and not merely an entry count.
 *
 * The key never leaves this module — it is never logged, persisted or
 * rendered — so it deliberately does NOT run `boundRunEventReason`'s
 * redaction. Only the row's `reason` is durable, and that one is still
 * redacted; re-running the credential regexes here would mean a second copy of
 * patterns that were promoted specifically so there is exactly one.
 *
 * Length-framing is retained from BST-1737 even though a fixed-width digest is
 * already self-delimiting: it costs nothing, keeps that settled ruling and its
 * test intact, and stays correct if the digest width ever changes.
 */
function compactionFailureKey(threadId: string, error: unknown): string {
  // Same extraction `boundRunEventReason` performs, applied before truncation.
  const message = error instanceof Error ? error.message : String(error);
  const shape = message.replace(VOLATILE_TIMESTAMP, '<ts>').replace(VOLATILE_UUID, '<id>');
  return `${threadId.length}:${threadId}${createHash('sha256').update(shape).digest('hex')}`;
}

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
  // LENGTH-FRAMED, not delimited: unambiguous for any thread id and digest
  // without depending on some character being impossible in either. It was a
  // NUL separator until #3119's own review quoted this line and reproduced that
  // byte, which `execFileSync` refuses in an argv string — see
  // docs/agents/assistant-persistence.md. A key that never leaves this `Set`
  // must carry nothing the rest of the toolchain cannot transport.
  const key = compactionFailureKey(threadId, input.error);
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
      latchCompactionFailure(key);
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
