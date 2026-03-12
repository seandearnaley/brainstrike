import { describe, expect, it, vi } from 'vitest';

const createBrowserEmbeddingQueueMock = vi.fn(() => ({ id: 'queue' }));
const registerEmbeddingQueueFactoryMock = vi.fn();
const registerEmbeddingRuntimeConfigMock = vi.fn();

vi.mock('@brainstrike/queue/browser', () => ({
  createBrowserEmbeddingQueue: createBrowserEmbeddingQueueMock,
}));

vi.mock('@brainstrike/embeddings/runtime-config', () => ({
  registerEmbeddingQueueFactory: registerEmbeddingQueueFactoryMock,
  registerEmbeddingRuntimeConfig: registerEmbeddingRuntimeConfigMock,
}));

describe('create-embedding-queue', () => {
  it('creates a singleton embedding queue', async () => {
    const module = await import('../../renderer/create-embedding-queue');

    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledWith({
      requireWorkerpool: true,
      worker: {
        name: 'desktop-renderer-embedding',
        workerUrl: expect.any(String),
      },
    });
    expect(registerEmbeddingRuntimeConfigMock).toHaveBeenCalledWith({
      streamingWorkerUrl: expect.any(String),
    });
    expect(registerEmbeddingQueueFactoryMock).toHaveBeenCalledTimes(1);
    expect(registerEmbeddingQueueFactoryMock).toHaveBeenCalledWith(expect.any(Function));
    expect(module.embeddingQueue).toBe(module.getEmbeddingQueue());
    expect(module.getEmbeddingQueue()).toEqual({ id: 'queue' });
    expect(module.createBrowserEmbeddingQueue).toBe(createBrowserEmbeddingQueueMock);
  });
});
