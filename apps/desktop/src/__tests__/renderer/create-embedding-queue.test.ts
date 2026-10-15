// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createBrowserEmbeddingQueueMock = vi.fn(() => ({
  dispose: vi.fn(async () => {}),
  id: 'queue',
}));
const registerEmbeddingQueueFactoryMock = vi.fn();
const registerEmbeddingRuntimeConfigMock = vi.fn();
const embeddingWorkerTelemetrySink = { id: 'desktop-embedding-telemetry' };

vi.mock('@brainstrike/embedding-worker', () => ({
  embeddingWorkerTelemetrySink,
}));

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
    expect(module.getEmbeddingQueue()).toMatchObject({ id: 'queue' });
    expect(module.getEmbeddingQueue()).toBe(module.getEmbeddingQueue());
    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledWith({
      requireWorkerpool: true,
      worker: {
        name: 'desktop-renderer-embedding',
        telemetry: embeddingWorkerTelemetrySink,
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
    expect(factory()).toMatchObject({ id: 'queue' });
    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    expect(factory()).toBe(factory());
    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledTimes(1);
  });

  it('retains physical retirement and keeps lazy admission fenced until an explicit fresh generation', async () => {
    const module = await import('../../renderer/create-embedding-queue');
    const physical = Promise.withResolvers<void>();
    const dispose = vi.fn(() => physical.promise);
    createBrowserEmbeddingQueueMock.mockReturnValueOnce({ dispose, id: 'old' });
    const original = module.getEmbeddingQueue();
    const factory = registerEmbeddingQueueFactoryMock.mock.calls[0]?.[0];
    let joined = false;
    const first = module.retireEmbeddingQueue();
    const second = module.retireEmbeddingQueue().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(joined).toBe(false);
    expect(() => module.getEmbeddingQueue()).toThrow('retir');
    expect(() => factory()).toThrow('retir');
    physical.resolve();
    await Promise.all([first, second]);
    expect(() => module.getEmbeddingQueue()).toThrow('retir');
    await module.reopenEmbeddingQueue(() => true);
    expect(module.getEmbeddingQueue()).not.toBe(original);
    expect(factory()).toBe(module.getEmbeddingQueue());
    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledTimes(2);
  });

  it('retains a failed physical retirement and refuses a replacement queue', async () => {
    const module = await import('../../renderer/create-embedding-queue');
    const failure = new Error('Worker exit join failed');
    const dispose = vi.fn(async () => {
      throw failure;
    });
    createBrowserEmbeddingQueueMock.mockReturnValueOnce({ dispose, id: 'old' });
    module.getEmbeddingQueue();
    await expect(module.retireEmbeddingQueue()).rejects.toBe(failure);
    await expect(module.retireEmbeddingQueue()).rejects.toBe(failure);
    await expect(module.reopenEmbeddingQueue(() => true)).rejects.toBe(failure);
    expect(() => module.getEmbeddingQueue()).toThrow('retir');
    expect(dispose).toHaveBeenCalledOnce();
    expect(createBrowserEmbeddingQueueMock).toHaveBeenCalledOnce();
  });
});
