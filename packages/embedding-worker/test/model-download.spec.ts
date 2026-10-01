import type { PretrainedModelOptions } from '@huggingface/transformers';
import { describe, expect, it, vi } from 'vitest';
import { downloadEmbeddingModelArtifacts } from '../src/model-download';

describe('temporary public download pipeline ownership', () => {
  it('awaits disposal exactly once before success and uses public progress_callback', async () => {
    const held = Promise.withResolvers<void>();
    const dispose = vi.fn(() => held.promise);
    const progress = vi.fn();
    const pipeline = vi.fn(
      async (_task: 'feature-extraction', _model: string, options: PretrainedModelOptions) => {
        options.progress_callback?.({
          file: 'model.onnx',
          loaded: 10,
          name: 'model-a',
          progress: 100,
          status: 'progress',
          total: 10,
        });
        return { dispose };
      }
    );
    let completed = false;
    const download = downloadEmbeddingModelArtifacts(
      { cacheDir: '/models', id: 'download-a', model: 'model-a' },
      pipeline,
      progress
    ).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(progress).toHaveBeenCalledWith(99);
    expect(pipeline).toHaveBeenCalledWith(
      'feature-extraction',
      'model-a',
      expect.objectContaining({ cache_dir: '/models', progress_callback: expect.any(Function) })
    );
    held.resolve();
    await download;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects failed creation and disposal without reporting completion', async () => {
    const failure = new Error('session release failed');
    const dispose = vi.fn().mockRejectedValue(failure);
    await expect(
      downloadEmbeddingModelArtifacts({ id: 'a', model: 'a' }, async () => ({ dispose }), vi.fn())
    ).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledOnce();
    const pipeline = vi.fn().mockRejectedValue(new Error('download failed'));
    await expect(
      downloadEmbeddingModelArtifacts({ id: 'b', model: 'b' }, pipeline, vi.fn())
    ).rejects.toThrow('download failed');
    expect(dispose).toHaveBeenCalledOnce();
  });
});
