import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingHostModelCacheResponseReport } from '../../../embedding-host-model-cache';
import { createEmbeddingHostModelCacheRequest } from '../../../embedding-host-model-cache';

const readModelCacheStatus = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/embedding-worker', () => ({ readModelCacheStatus }));
vi.mock('@brainstrike/embedding-worker/vite', () => ({
  resolveViteEmbeddingWorkerUrlHref: () => '/assets/embedding.worker.js#ort',
}));

const { answerModelCacheRequest } = await import(
  '../../../renderer/components/embedding-host-model-cache'
);

/** BST-2241: the hidden host answers Main from its own embedding worker's cache. */
describe('answerModelCacheRequest', () => {
  const request = createEmbeddingHostModelCacheRequest('runtime-1', [
    { device: 'wasm', dtype: 'q8', modelId: 'granite' },
  ]);

  beforeEach(() => {
    readModelCacheStatus.mockReset();
  });

  it('reads the cache in this host’s embedding worker and reports the answer', async () => {
    readModelCacheStatus.mockResolvedValue([true]);
    const report = vi.fn<(response: EmbeddingHostModelCacheResponseReport) => void>();

    await answerModelCacheRequest(request, report);

    expect(readModelCacheStatus).toHaveBeenCalledWith(
      '/assets/embedding.worker.js#ort',
      request.payload.plans
    );
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { cached: [true] },
        requestId: request.requestId,
        type: 'result',
      })
    );
  });

  it('reports the worker’s failure as the request’s error', async () => {
    readModelCacheStatus.mockRejectedValue(new Error('worker failed'));
    const report = vi.fn<(response: EmbeddingHostModelCacheResponseReport) => void>();

    await answerModelCacheRequest(request, report);

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ message: 'worker failed' }),
        requestId: request.requestId,
        type: 'error',
      })
    );
  });
});
