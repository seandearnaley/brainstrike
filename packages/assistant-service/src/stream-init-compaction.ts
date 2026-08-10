import type { AgentMessage, RuntimeData, StreamChunk } from '@brainstrike/agent';
import type { AssistantChildRunUsage } from '@brainstrike/assistant-contract/run-usage';
import type { ScopedLogger } from '@brainstrike/logging';
import type {
  AgentStreamCapabilities,
  AgentStreamCapabilityKinds,
  AgentStreamMemoryResult,
} from './stream-init.js';

// Extracted from stream-init.ts (BST-1200 milestone 2 review response, item 6
// / max-file-lines gate) — the pre-request compaction trigger and its
// usage-chunk prepend, with no behavior change from the original inline
// definitions. Kept as its own module because it is the one cohesive,
// independently testable slice of stream-init.ts's request-init flow: it
// owns exactly the "should we compact before this turn's stream starts, and
// how does that surface as a stream chunk" concern, importing only the
// capability/runtime types it needs from the root module.

export interface PreRequestCompactionCapabilityResult {
  readonly kind: 'agentic' | 'deterministic' | 'noop';
  readonly usage?: AssistantChildRunUsage;
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
}): Promise<PreRequestCompactionCapabilityResult | undefined> {
  if (!input.memoryResult) {
    return;
  }
  input.runtime.contextOverflowRecovery =
    input.capabilities.compaction.createContextOverflowRecovery({
      memoryStore: input.memoryResult.store,
      runtimeData: input.runtime,
    });
  try {
    return await input.capabilities.compaction.runPreRequest({
      memoryStore: input.memoryResult.store,
      requestMessages: input.messages,
      runId: input.runId,
      runtimeData: input.runtime,
      signal: input.signal,
    });
  } catch (error) {
    input.logger.warn('Pre-request conversation compaction failed; continuing the user turn.', {
      code: 'conversation_compaction_pre_request_failed',
      error,
    });
    return;
  }
}

export function withCompactionUsageChunk(
  source: AsyncIterable<StreamChunk>,
  result: { readonly usage?: AssistantChildRunUsage } | undefined
): AsyncIterable<StreamChunk> {
  if (!result?.usage) {
    return source;
  }
  return prependStreamChunks([{ type: 'child-run-usage', value: result.usage }], source);
}

export function trustedCompactionOverlayFields(
  lookup: RuntimeData['compactionOverlayLookup']
): Pick<RuntimeData, 'compactionOverlayLookup'> {
  return lookup ? { compactionOverlayLookup: lookup } : {};
}
