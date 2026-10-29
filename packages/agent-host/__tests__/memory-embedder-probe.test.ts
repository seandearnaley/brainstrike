import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { expect, test } from 'vitest';
import { probeHostMemoryEmbedder } from '../src/memory-embedder-probe.js';

/**
 * BST-2227: a probe cancelled while its provider call runs stays a
 * cancellation, even when the provider ignores the abort and answers.
 */
test('a provider that answers after the probe was cancelled does not pass the test', async () => {
  const controller = new AbortController();
  const cancelled = new Error('The client cancelled the request');
  const embedder: MastraEmbeddingModel<string> = {
    doEmbed: async () => {
      // The client's cancellation lands while the provider call is in flight.
      controller.abort(cancelled);
      return { embeddings: [[0.1, 0.2]], warnings: [] };
    },
    maxEmbeddingsPerCall: 1,
    modelId: 'text-embedding-3-small',
    provider: 'openai',
    specificationVersion: 'v3',
    supportsParallelCalls: true,
  };

  await expect(
    probeHostMemoryEmbedder(
      async () => ({ embedder, identity: { modelId: 'openai::text-embedding-3-small' } }),
      { memorySettings: {} },
      controller.signal
    )
  ).rejects.toBe(cancelled);
});

test('probes a current AI SDK embedding model as it is constructed', async () => {
  const embedder: MastraEmbeddingModel<string> = {
    doEmbed: async () => ({ embeddings: [[0.1, 0.2, 0.3]], warnings: [] }),
    maxEmbeddingsPerCall: 1,
    modelId: 'text-embedding-3-small',
    provider: 'openai',
    specificationVersion: 'v4',
    supportsParallelCalls: true,
  };

  await expect(
    probeHostMemoryEmbedder(
      async () => ({ embedder, identity: { modelId: 'openai::text-embedding-3-small' } }),
      { memorySettings: {} },
      new AbortController().signal
    )
  ).resolves.toMatchObject({ dimensions: 3, modelId: 'openai::text-embedding-3-small' });
});
