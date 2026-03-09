import { describe, expect, it, vi } from 'vitest';

const createBrowserEmbeddingQueueMock = vi.fn(() => ({ id: 'queue' }));

vi.mock('@brainstrike/queue/browser', () => ({
  createBrowserEmbeddingQueue: createBrowserEmbeddingQueueMock,
}));

describe('create-embedding-queue', () => {
  it('creates a singleton embedding queue', async () => {
    const module = await import('../../renderer/create-embedding-queue');

    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledWith({
      requireWorkerpool: true,
      worker: { name: 'desktop-renderer-embedding' },
    });
    expect(module.embeddingQueue).toBe(module.getEmbeddingQueue());
    expect(module.getEmbeddingQueue()).toEqual({ id: 'queue' });
    expect(module.createBrowserEmbeddingQueue).toBe(createBrowserEmbeddingQueueMock);
  });
});
