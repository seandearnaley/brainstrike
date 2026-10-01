import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEmbeddingRuntimeConfig, resetEmbeddingRuntimeConfig } from '../runtime-config.js';
import { TransformersBackend } from '../transformers-backend.js';

const mocks = vi.hoisted(() => ({ download: vi.fn(), pipeline: vi.fn(), terminate: vi.fn() }));
vi.mock('@brainstrike/embedding-worker', () => ({
  StreamingEmbeddingWorkerClient: class {
    download = mocks.download;
    terminate = mocks.terminate;
  },
}));
vi.mock('@huggingface/transformers', () => ({ pipeline: mocks.pipeline }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.download.mockResolvedValue(undefined);
  mocks.pipeline.mockResolvedValue({ dispose: vi.fn() });
  resetEmbeddingRuntimeConfig();
});

describe('owned model download', () => {
  it('executes in the registered worker and releases it before completing', async () => {
    registerEmbeddingRuntimeConfig({ streamingWorkerUrl: '/owned-worker.js' });
    const backend = new TransformersBackend();
    await backend.downloadModel('model-a');
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'model-a' }),
      expect.any(Object)
    );
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(mocks.terminate).toHaveBeenCalledOnce();
    await backend.dispose();
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it('rejects missing runtime configuration before allocating a pipeline', async () => {
    await expect(new TransformersBackend().downloadModel('model-a')).rejects.toThrow('worker URL');
    expect(mocks.pipeline).not.toHaveBeenCalled();
  });

  it('joins and terminates a pending download on disposal', async () => {
    registerEmbeddingRuntimeConfig({ streamingWorkerUrl: '/owned-worker.js' });
    const held = Promise.withResolvers<void>();
    mocks.download.mockReturnValue(held.promise);
    const backend = new TransformersBackend();
    const pending = backend.downloadModel('model-a');
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    let disposed = false;
    const disposal = backend.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);
    const stopReason: unknown = mocks.terminate.mock.calls[0]?.[0];
    held.reject(stopReason);
    await expect(pending).rejects.toBe(stopReason);
    await disposal;
    expect(disposed).toBe(true);
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
  it.each(['factory failed', 'session release failed'])(
    'terminates failed downloads before exposing %s',
    async (message) => {
      registerEmbeddingRuntimeConfig({ streamingWorkerUrl: '/owned-worker.js' });
      mocks.download.mockRejectedValue(new Error(message));
      const backend = new TransformersBackend();
      await expect(backend.downloadModel('model-a')).rejects.toThrow(message);
      expect(mocks.terminate).toHaveBeenCalledOnce();
      await backend.dispose();
      expect(mocks.terminate).toHaveBeenCalledOnce();
    }
  );
});
