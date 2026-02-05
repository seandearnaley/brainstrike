import { beforeEach, describe, expect, it, vi } from 'vitest';

const createBrowserEmbeddingQueue = vi.fn(() => ({ id: 'queue' }));

vi.mock('@brainstrike/queue', () => ({
  createBrowserEmbeddingQueue,
}));

describe('desktop create-embedding-queue', () => {
  beforeEach(() => {
    vi.resetModules();
    createBrowserEmbeddingQueue.mockClear();
  });

  it('creates a singleton embedding queue with desktop worker metadata', async () => {
    const module = await import('../../renderer/create-embedding-queue');

    expect(createBrowserEmbeddingQueue).toHaveBeenCalledWith({
      requireWorkerpool: true,
      worker: { name: 'desktop-renderer-embedding' },
    });

    expect(module.embeddingQueue).toBe(module.getEmbeddingQueue());
    expect(module.getEmbeddingQueue()).toEqual({ id: 'queue' });
  });
});
