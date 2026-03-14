import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../packages/embedding-worker/src/embedding.worker.ts?worker&url', () => ({
  default: '/assets/embedding-worker.js',
}));

describe('resolveEmbeddingWorkerUrlHref', () => {
  it('resolves the embedding worker from the package worker subpath', async () => {
    const { resolveEmbeddingWorkerUrlHref } = await import('../resolve-embedding-worker-url');

    expect(resolveEmbeddingWorkerUrlHref()).toBe('/assets/embedding-worker.js');
  });
});
