import { projectModelCatalog } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingHostQueryEmbeddingRequest } from '../../../embedding-host-shared';
import { loadQueryEmbeddingModelConfig } from '../../../renderer/components/embedding-host-query-model';

const snapshot = projectModelCatalog({ models: [], providers: [] });
const model = snapshot.models.find((row) => row.id === 'Xenova/all-MiniLM-L6-v2');
if (!model) {
  throw new Error('The supported MiniLM catalog entry is missing');
}
const request: EmbeddingHostQueryEmbeddingRequest = {
  channel: 'query-embedding',
  payload: { dimensions: 384, modelId: model.id, modelKey: `local::${model.id}`, query: 'fixture' },
  requestId: 'embedding-query:catalog',
  runtimeId: 'test-runtime',
  type: 'request',
};

describe('hidden inference model catalog without a database', () => {
  it('resolves the actual canonical local metadata through the read-only capability', async () => {
    const read = vi.fn(async () => snapshot);
    const config = await loadQueryEmbeddingModelConfig({ read }, request);
    expect(config).toMatchObject({
      dimensions: 384,
      id: model.id,
      name: model.name,
      origin: 'local',
    });
    expect(read).toHaveBeenCalledOnce();
  });
  it('preserves catalog refusal instead of opening a database or substituting metadata', async () => {
    const failure = new Error('catalog owner closed');
    await expect(
      loadQueryEmbeddingModelConfig(
        {
          read: async () => {
            throw failure;
          },
        },
        request
      )
    ).rejects.toBe(failure);
  });
  it('uses the explicit native plan without reading the catalog', async () => {
    const read = vi.fn(async () => {
      throw new Error('must not read');
    });
    const pinned = {
      ...request,
      payload: {
        ...request.payload,
        inferencePlan: {
          device: 'wasm' as const,
          dimensions: 384,
          dtype: 'q8' as const,
          modelId: model.id,
        },
      },
    };
    await expect(loadQueryEmbeddingModelConfig({ read }, pinned)).resolves.toMatchObject({
      dimensions: 384,
      id: model.id,
    });
    expect(read).not.toHaveBeenCalled();
  });
});
