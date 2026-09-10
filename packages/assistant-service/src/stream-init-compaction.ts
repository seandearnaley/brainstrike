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
  readonly failure?: StreamChunk;
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
 * Intentionally in-memory only (no persistence, no eviction), mirroring
 * `warnedBaselineExceedsTargetThreadIds` in
 * apps/desktop/src/assistant-server/conversation-compaction.ts: a restart
 * re-arms it, and the set is bounded by real thread cardinality times distinct
 * failure reasons, not by request volume.
 */
const reportedCompactionFailures = new Set<string>();

function compactionFailureChunk(input: {
  readonly error: unknown;
  readonly threadId: string | undefined;
}): StreamChunk | undefined {
  // Redacted and length-bounded because this string becomes DURABLE run-event
  // metadata and a rendered row: compaction failures quote provider/model and
  // can carry transport or DB detail.
  const reason = boundRunEventReason(input.error);
  const key = `${input.threadId ?? ''}\u0000${reason}`;
  if (reportedCompactionFailures.has(key)) {
    return;
  }
  reportedCompactionFailures.add(key);
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

async function* prependStreamChunks(
  chunks: readonly StreamChunk[],
  source: AsyncIterable<StreamChunk>
): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
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
  const prelude: StreamChunk[] = [];
  if (outcome.failure) {
    prelude.push(outcome.failure);
  }
  if (outcome.result?.usage) {
    prelude.push({ type: 'child-run-usage', value: outcome.result.usage });
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
