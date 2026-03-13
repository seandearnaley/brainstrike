import { beforeEach, describe, expect, it, vi } from 'vitest';

const createBrowserEmbeddingQueue = vi.fn(() => ({ id: 'web-queue' }));
const registerEmbeddingQueueFactory = vi.fn();
const registerEmbeddingRuntimeConfig = vi.fn();

vi.mock('@brainstrike/queue/browser', () => ({
  createBrowserEmbeddingQueue,
}));

vi.mock('@brainstrike/embeddings/runtime-config', () => ({
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
}));

describe('web create-embedding-queue', () => {
  beforeEach(() => {
    vi.resetModules();
    createBrowserEmbeddingQueue.mockClear();
    registerEmbeddingQueueFactory.mockClear();
    registerEmbeddingRuntimeConfig.mockClear();
  });

  it('creates a singleton embedding queue', async () => {
    const module = await import('../create-embedding-queue');

    expect(createBrowserEmbeddingQueue).not.toHaveBeenCalled();
    expect(module.getEmbeddingQueue()).toEqual({ id: 'web-queue' });
    expect(module.getEmbeddingQueue()).toBe(module.getEmbeddingQueue());
    expect(createBrowserEmbeddingQueue).toHaveBeenCalledWith({
      requireWorkerpool: true,
      worker: {
        workerUrl: expect.any(String),
      },
    });
    expect(registerEmbeddingRuntimeConfig).toHaveBeenCalledWith({
      streamingWorkerUrl: expect.any(String),
    });
    expect(registerEmbeddingQueueFactory).toHaveBeenCalledTimes(1);
    expect(registerEmbeddingQueueFactory).toHaveBeenCalledWith(expect.any(Function));
  });
});
