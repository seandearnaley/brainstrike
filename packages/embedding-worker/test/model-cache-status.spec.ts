import type { ModelCachePlan, ModelCacheStatusResponse } from '@brainstrike/indexing-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerModelCacheStatus,
  type ModelCacheRegistry,
  readModelCacheStatus,
} from '../src/model-cache-status';

/** BST-2241: the worker reads its model cache for each download plan; nothing is fetched. */
const GRANITE: ModelCachePlan = {
  device: 'wasm',
  dtype: 'q8',
  modelId: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  revision: '0123456789abcdef0123456789abcdef01234567',
};
const MINILM: ModelCachePlan = { device: 'wasm', dtype: 'q4', modelId: 'Xenova/all-MiniLM-L6-v2' };

describe('answerModelCacheStatus', () => {
  it('asks Transformers.js about each plan, in order, with its device, dtype and revision', async () => {
    const isPipelineCached = vi.fn(
      async (_task: string, modelId: string) => modelId === MINILM.modelId
    );
    const registry: ModelCacheRegistry = { is_pipeline_cached: isPipelineCached };
    const post = vi.fn<(response: ModelCacheStatusResponse) => void>();

    await answerModelCacheStatus(
      { id: 'r1', plans: [GRANITE, MINILM], type: 'model-cache-status' },
      async () => registry,
      post
    );

    expect(isPipelineCached).toHaveBeenNthCalledWith(1, 'feature-extraction', GRANITE.modelId, {
      device: 'wasm',
      dtype: 'q8',
      revision: GRANITE.revision,
    });
    expect(isPipelineCached).toHaveBeenNthCalledWith(2, 'feature-extraction', MINILM.modelId, {
      device: 'wasm',
      dtype: 'q4',
    });
    expect(post).toHaveBeenCalledExactlyOnceWith({
      cached: [false, true],
      id: 'r1',
      type: 'model-cache-status-result',
    });
  });

  it('answers a failed cache read as an error for that request', async () => {
    const post = vi.fn<(response: ModelCacheStatusResponse) => void>();

    await answerModelCacheStatus(
      { id: 'r2', plans: [MINILM], type: 'model-cache-status' },
      async () => {
        throw new Error('This embedding runtime has no model registry to read its cache.');
      },
      post
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      id: 'r2',
      message: 'This embedding runtime has no model registry to read its cache.',
      type: 'model-cache-status-error',
    });
  });

  it('refuses a malformed plan with an error for its request', async () => {
    const post = vi.fn<(response: ModelCacheStatusResponse) => void>();
    const loadRegistry = vi.fn();

    await answerModelCacheStatus(
      { id: 'r3', plans: [{ ...MINILM, dtype: 'int3' }], type: 'model-cache-status' },
      loadRegistry,
      post
    );

    expect(loadRegistry).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r3', type: 'model-cache-status-error' })
    );
  });
});

/** A worker that answers the request it receives with `answer(request)`. */
function stubWorker(answer: (request: { id: string }) => unknown) {
  const terminated = vi.fn();
  const names: string[] = [];
  class FakeWorker extends EventTarget {
    readonly url: string | URL;

    constructor(url: string | URL, options?: WorkerOptions) {
      super();
      this.url = url;
      names.push(options?.name ?? '');
    }
    postMessage(request: { id: string }): void {
      queueMicrotask(() => {
        // Unrelated traffic first: workerpool's ready signal, and its "unknown
        // method" reply, which echoes the request's id, are not the answer.
        this.dispatchEvent(new MessageEvent('message', { data: 'ready' }));
        this.dispatchEvent(
          new MessageEvent('message', {
            data: {
              error: { message: 'Unknown method "undefined"' },
              id: request.id,
              result: null,
            },
          })
        );
        this.dispatchEvent(new MessageEvent('message', { data: answer(request) }));
      });
    }
    terminate = terminated;
  }
  vi.stubGlobal('Worker', FakeWorker);
  return { names, terminated };
}

describe('readModelCacheStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the worker’s answer for its own request, then terminates the worker', async () => {
    const { names, terminated } = stubWorker((request) => ({
      cached: [true, false],
      id: request.id,
      type: 'model-cache-status-result',
    }));

    await expect(readModelCacheStatus('/worker.js', [GRANITE, MINILM])).resolves.toEqual([
      true,
      false,
    ]);
    expect(terminated).toHaveBeenCalledOnce();
    // The embedding worker refuses any name outside its managed identity contract.
    expect(names).toEqual([expect.stringMatching(/^brainstrike-embedding-worker:model-cache-/u)]);
  });

  it('rejects with the worker’s error, and an answer of the wrong length', async () => {
    stubWorker((request) => ({
      id: request.id,
      message: 'cache unavailable',
      type: 'model-cache-status-error',
    }));
    await expect(readModelCacheStatus('/worker.js', [MINILM])).rejects.toThrow('cache unavailable');

    stubWorker((request) => ({
      cached: [true],
      id: request.id,
      type: 'model-cache-status-result',
    }));
    await expect(readModelCacheStatus('/worker.js', [GRANITE, MINILM])).rejects.toThrow(
      'answer every plan'
    );
  });

  it('times out a worker that never answers', async () => {
    const { terminated } = stubWorker(() => undefined);

    await expect(readModelCacheStatus('/worker.js', [MINILM], { timeoutMs: 10 })).rejects.toThrow(
      'did not report its model cache in time'
    );
    expect(terminated).toHaveBeenCalledOnce();
  });

  it('spawns no worker for an empty catalog', async () => {
    const created = vi.fn();
    vi.stubGlobal('Worker', created);

    await expect(readModelCacheStatus('/worker.js', [])).resolves.toEqual([]);
    expect(created).not.toHaveBeenCalled();
  });
});
