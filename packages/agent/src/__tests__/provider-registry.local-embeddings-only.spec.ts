import { describe, expect, it } from 'vitest';
import { getProviderDefinition } from '../providers/types';

/**
 * The built-in `local` provider is EMBEDDINGS-ONLY. Its chat half (Gemma 4 E2B
 * through transformers.js) was retired: a 131072-token declared window that
 * had to be contradicted by an 8192-token runtime budget because the WebGPU
 * prefill allocates an O(seq^2) attention buffer, tool calling that never
 * became reliable, and no token streaming.
 *
 * These assertions are the contract that keeps a chat model from being added
 * back to this provider by accident — `capabilities.llm` is what the request
 * path, the model picker and the tool-discovery adapter all read.
 */
describe('built-in local provider', () => {
  it('declares embeddings and no LLM capability', () => {
    const local = getProviderDefinition('local');

    expect(local.capabilities.embeddings).toBe(true);
    expect(local.capabilities.llm).toBe(false);
  });

  it('offers no chat models', () => {
    const local = getProviderDefinition('local');

    expect(local.models.filter((model) => model.type === 'llm')).toEqual([]);
  });

  it('keeps every on-device embedding model', () => {
    const local = getProviderDefinition('local');
    const embeddingModelIds = local.models
      .filter((model) => model.type === 'embedding')
      .map((model) => model.id);

    expect(embeddingModelIds).toEqual(
      expect.arrayContaining([
        'Xenova/all-MiniLM-L6-v2',
        'Xenova/bge-base-en-v1.5',
        'Xenova/bge-large-en-v1.5',
        'Xenova/bge-small-en-v1.5',
        'Xenova/jina-embeddings-v2-base-en',
        'jinaai/jina-embeddings-v2-base-code',
        'onnx-community/granite-embedding-small-english-r2-ONNX',
      ])
    );
    expect(embeddingModelIds).toHaveLength(7);
  });
});
