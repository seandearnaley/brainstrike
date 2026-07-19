import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    vi.resetModules();
    createBrowserEmbeddingQueueMock.mockClear();
    registerEmbeddingQueueFactoryMock.mockClear();
    registerEmbeddingRuntimeConfigMock.mockClear();
  });

  it('creates a singleton embedding queue', async () => {
    const module = await import('../../renderer/create-embedding-queue');

    expect(createBrowserEmbeddingQueueMock).not.toHaveBeenCalled();
    expect(module.getEmbeddingQueue()).toEqual({ id: 'queue' });
    expect(module.getEmbeddingQueue()).toBe(module.getEmbeddingQueue());
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
    expect(module.createBrowserEmbeddingQueue).toBe(createBrowserEmbeddingQueueMock);
  });

  it('registers a lazy embedding queue factory without constructing the queue', async () => {
    const module = await import('../../renderer/create-embedding-queue');

    module.registerDesktopEmbeddingRuntimeConfig();

    expect(createBrowserEmbeddingQueueMock).not.toHaveBeenCalled();
    expect(registerEmbeddingRuntimeConfigMock).toHaveBeenCalledWith({
      streamingWorkerUrl: expect.any(String),
    });
    expect(registerEmbeddingQueueFactoryMock).toHaveBeenCalledTimes(1);
    const factory = registerEmbeddingQueueFactoryMock.mock.calls[0]?.[0];
    expect(factory).toEqual(expect.any(Function));

    // Invoking the registered factory constructs the singleton on demand.
    expect(factory()).toEqual({ id: 'queue' });
    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    expect(factory()).toBe(factory());
    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledTimes(1);
  });
});
