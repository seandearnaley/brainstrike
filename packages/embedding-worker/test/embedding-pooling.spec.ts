import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorker, pipelineMock, resetMocks } from './helpers/pipeline-test-setup';

/** BST-1939: pooling is a model property carried beside the model identity. */
describe('embed request pooling', () => {
  beforeEach(() => {
    resetMocks();
  });

  it.each([
    [undefined, 'mean'],
    ['mean', 'mean'],
    ['cls', 'cls'],
  ] as const)('pooling %s reaches the vendor pipeline as %s', async (pooling, expected) => {
    const extractor = vi.fn(async () => new Float32Array([1, 0, 0]));
    pipelineMock.mockResolvedValue(extractor);
    const runEmbedding = await loadWorker();
    await runEmbedding({
      deviceHint: 'wasm',
      id: `pooling-${String(pooling)}`,
      model: 'test-model',
      ...(pooling === undefined ? {} : { pooling }),
      texts: ['hello'],
      type: 'embed',
    });
    expect(extractor).toHaveBeenCalledWith(['hello'], { normalize: false, pooling: expected });
  });
});
