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

  it('registers a lazy embedding queue factory without constructing the queue', async () => {
    const module = await import('../create-embedding-queue');

    module.registerWebEmbeddingRuntimeConfig();

    expect(createBrowserEmbeddingQueue).not.toHaveBeenCalled();
    expect(registerEmbeddingRuntimeConfig).toHaveBeenCalledWith({
      streamingWorkerUrl: expect.any(String),
    });
    expect(registerEmbeddingQueueFactory).toHaveBeenCalledTimes(1);
    const factory = registerEmbeddingQueueFactory.mock.calls[0]?.[0];
    expect(factory).toEqual(expect.any(Function));

    expect(factory()).toEqual({ id: 'web-queue' });
    expect(createBrowserEmbeddingQueue).toHaveBeenCalledTimes(1);
  });
});
