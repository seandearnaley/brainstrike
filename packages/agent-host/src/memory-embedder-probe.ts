import {
  BoundaryFailureError,
  fault,
  MEMORY_FAILURE_CODES,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { classifyMemoryFailure } from './adapters/memory-failure.ts';
import type { HostPlatform } from './ports.ts';
import type { HostParams } from './protocol.ts';
import {
  HOST_MEMORY_EMBEDDER_PROBE_TEXT,
  type HostMemoryEmbedderProbeResult,
} from './protocol-memory.ts';

/** One provider call, no retries: a retry would hide the failure the probe exists to show. */
async function embedProbeText(
  model: MastraEmbeddingModel<string>,
  abortSignal: AbortSignal
): Promise<readonly number[] | undefined> {
  const values = [HOST_MEMORY_EMBEDDER_PROBE_TEXT];
  switch (model.specificationVersion) {
    case 'v1':
      return (await model.doEmbed({ abortSignal, values })).embeddings[0];
    case 'v2':
      return (await model.doEmbed({ abortSignal, values })).embeddings[0];
    case 'v3':
      return (await model.doEmbed({ abortSignal, values })).embeddings[0];
  }
}

/**
 * BST-2227 `memory/embedder/probe`: the platform resolves the embedder these
 * settings select, credentials included, as a run's admission does; one probe
 * text is embedded and timed. A failure reads as a run's embedder failure
 * does (BST-2202): the platform's hosted classification, the provider's HTTP
 * status and the remedy, never the provider's body or a key.
 */
export async function probeHostMemoryEmbedder(
  resolveMemoryEmbedder: HostPlatform['resolveMemoryEmbedder'],
  params: HostParams<'memory/embedder/probe'>,
  signal: AbortSignal
): Promise<HostMemoryEmbedderProbeResult> {
  if (!resolveMemoryEmbedder) {
    throw refusalError(
      'configuration',
      'memory.unavailable',
      'This host cannot test a memory embedder'
    );
  }
  const { embedder, identity } = await resolveMemoryEmbedder({
    memorySettings: params.memorySettings,
    signal,
  });
  signal.throwIfAborted();
  const started = performance.now();
  let embedding: readonly number[] | undefined;
  try {
    embedding = await embedProbeText(embedder, signal);
  } catch (cause) {
    // A cancelled probe is the cancellation, not an embedder failure.
    signal.throwIfAborted();
    throw new BoundaryFailureError(
      classifyMemoryFailure('embedder test', cause, {
        attribution: (failure) => ({
          cause:
            typeof failure === 'object' && failure !== null ? failure : new Error(String(failure)),
          component: 'embedder',
        }),
        embedder: identity,
      }),
      { cause }
    );
  }
  // A provider that ignores the abort and answers anyway is still a cancelled probe.
  signal.throwIfAborted();
  const latencyMs = Math.round(performance.now() - started);
  if (!embedding || embedding.length === 0) {
    throw new BoundaryFailureError(
      fault({
        category: 'internal',
        code: MEMORY_FAILURE_CODES.embedder,
        message: `The embedding model (${identity.modelId}) returned no embedding for the test text.`,
        remedy: 'Retry, or choose another embedding model in Settings → Assistant Memory.',
      }),
      { cause: new Error('The embedder answered the probe with no vector') }
    );
  }
  return { dimensions: embedding.length, latencyMs, modelId: identity.modelId };
}
