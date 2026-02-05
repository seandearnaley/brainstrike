import { beforeEach, describe, expect, it, vi } from 'vitest';

const createBrowserEmbeddingQueue = vi.fn(() => ({ id: 'web-queue' }));

vi.mock('@brainstrike/queue', () => ({
  createBrowserEmbeddingQueue,
}));

describe('web create-embedding-queue', () => {
  beforeEach(() => {
    vi.resetModules();
    createBrowserEmbeddingQueue.mockClear();
  });

  it('creates a singleton embedding queue', async () => {
    const module = await import('../create-embedding-queue');

    expect(createBrowserEmbeddingQueue).toHaveBeenCalledWith({ requireWorkerpool: true });
    expect(module.embeddingQueue).toBe(module.getEmbeddingQueue());
    expect(module.getEmbeddingQueue()).toEqual({ id: 'web-queue' });
  });
});
