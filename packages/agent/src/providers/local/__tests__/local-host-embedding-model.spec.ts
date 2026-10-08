import { describe, expect, it, vi } from 'vitest';
import {
  createLocalHostEmbeddingModel,
  type LocalEmbeddingHostQuery,
} from '../local-host-embedding-model';

describe('createLocalHostEmbeddingModel', () => {
  it('embeds values sequentially through the host client with the local model key', async () => {
    const queries: LocalEmbeddingHostQuery[] = [];
    const model = createLocalHostEmbeddingModel({
      client: {
        queryEmbedding: (payload) => {
          queries.push(payload);
          return Promise.resolve([queries.length, 0, 0]);
        },
      },
      modelId: 'Xenova/all-MiniLM-L6-v2',
      resolveDimensions: () => Promise.resolve(384),
    });

    const result = await model.doEmbed({ values: ['first', 'second'] });

    expect(result.embeddings).toEqual([
      [1, 0, 0],
      [2, 0, 0],
    ]);
    expect(queries).toEqual([
      {
        dimensions: 384,
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        query: 'first',
      },
      {
        dimensions: 384,
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        query: 'second',
      },
    ]);
    expect(model.provider).toBe('local');
    expect(model.specificationVersion).toBe('v2');
    expect(model.supportsParallelCalls).toBe(false);
  });

  it('carries the caller abort signal to each host query', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const model = createLocalHostEmbeddingModel({
      client: {
        queryEmbedding: (_payload, options) => {
          signals.push(options?.signal);
          return Promise.resolve([0]);
        },
      },
      modelId: 'Xenova/all-MiniLM-L6-v2',
      resolveDimensions: () => Promise.resolve(1),
    });
    const controller = new AbortController();

    await model.doEmbed({ abortSignal: controller.signal, values: ['first', 'second'] });

    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it('resolves dimensions once and reuses them across calls', async () => {
    const resolveDimensions = vi.fn().mockResolvedValue(384);
    const model = createLocalHostEmbeddingModel({
      client: { queryEmbedding: () => Promise.resolve([0]) },
      modelId: 'Xenova/all-MiniLM-L6-v2',
      resolveDimensions,
    });

    await model.doEmbed({ values: ['a'] });
    await model.doEmbed({ values: ['b'] });

    expect(resolveDimensions).toHaveBeenCalledTimes(1);
  });

  it('retries dimension resolution after a failure instead of caching the rejection', async () => {
    const resolveDimensions = vi
      .fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce(384);
    const model = createLocalHostEmbeddingModel({
      client: { queryEmbedding: () => Promise.resolve([0]) },
      modelId: 'Xenova/all-MiniLM-L6-v2',
      resolveDimensions,
    });

    await expect(model.doEmbed({ values: ['a'] })).rejects.toThrow('catalog unavailable');
    await expect(model.doEmbed({ values: ['a'] })).resolves.toMatchObject({
      embeddings: [[0]],
    });
    expect(resolveDimensions).toHaveBeenCalledTimes(2);
  });

  it('propagates host query failures', async () => {
    const model = createLocalHostEmbeddingModel({
      client: {
        queryEmbedding: () => Promise.reject(new Error('embedding host stopped')),
      },
      modelId: 'Xenova/all-MiniLM-L6-v2',
      resolveDimensions: () => Promise.resolve(384),
    });

    await expect(model.doEmbed({ values: ['a'] })).rejects.toThrow('embedding host stopped');
  });
});
