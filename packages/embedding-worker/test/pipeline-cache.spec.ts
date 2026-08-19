import {
  EMBED_WORKER_INSTANCE_NAME_PREFIX,
  EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY,
} from '@brainstrike/indexing-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installMockOrtWebGpuDevice,
  loadWorker,
  makeExtractor,
  pipelineMock,
  resetMocks,
  workerEmitMock,
} from './helpers/pipeline-test-setup';

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

describe('pipeline cache metadata and dispose', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disposePipeline calls .dispose() and removes from cache', async () => {
    const disposeMock = vi.fn();
    pipelineMock.mockResolvedValue(
      Object.assign(async () => new Float32Array([1, 0, 0]), { dispose: disposeMock })
    );
    const runEmbedding = await loadWorker();

    // Load a pipeline to populate the cache
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'dispose-test',
      model: 'test-model',
      texts: ['hello'],
      type: 'embed',
    });
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    // Load same model again — should be a cache hit (no new pipeline call)
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'dispose-test-2',
      model: 'test-model',
      texts: ['world'],
      type: 'embed',
    });
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    // For direct disposePipeline testing, we need the pipeline to be webgpu
    // so invalidateWebGpuPipelines calls disposePipeline
    vi.stubGlobal('navigator', { gpu: {} });
    pipelineMock.mockResolvedValue(
      Object.assign(async () => new Float32Array([1, 0, 0]), { dispose: disposeMock })
    );

    // Reset modules to get a fresh worker with access to webgpu
    resetMocks();
    vi.stubGlobal('navigator', { gpu: {} });
    await installMockOrtWebGpuDevice();
    pipelineMock.mockResolvedValue(
      Object.assign(async () => new Float32Array([1, 0, 0]), { dispose: disposeMock })
    );
    const runEmbedding2 = await loadWorker();

    await runEmbedding2({
      deviceHint: 'webgpu',
      id: 'webgpu-dispose',
      model: 'gpu-model',
      texts: ['hello'],
      type: 'embed',
    });

    // Load again — cache hit
    pipelineMock.mockClear();
    await runEmbedding2({
      deviceHint: 'webgpu',
      id: 'webgpu-dispose-2',
      model: 'gpu-model',
      texts: ['world'],
      type: 'embed',
    });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('disposePipeline handles rejected pipeline gracefully', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    pipelineMock.mockRejectedValueOnce(new Error('load failed'));

    const runEmbedding = await loadWorker();

    // Attempt to load a pipeline that will fail
    await expect(
      runEmbedding({
        deviceHint: 'webgpu',
        id: 'fail-dispose',
        model: 'broken-model',
        texts: ['hello'],
        type: 'embed',
      })
    ).rejects.toThrow('load failed');

    // The failed entry should have been removed from cache (retry cleanup)
    // Loading again should trigger a new pipeline call
    await installMockOrtWebGpuDevice();
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const result = await runEmbedding({
      deviceHint: 'webgpu',
      id: 'retry-after-fail',
      model: 'broken-model',
      texts: ['hello'],
      type: 'embed',
    });
    expect(result.vectors).toHaveLength(1);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateWebGpuPipelines disposes only webgpu entries', async () => {
    vi.stubGlobal('navigator', { gpu: {} });

    let resolveLost: ((info: { reason?: string; message: string }) => void) | undefined;
    const lost = new Promise<{ reason?: string; message: string }>((resolve) => {
      resolveLost = resolve;
    });

    const disposeMock = vi.fn();
    const gpuExtractor = Object.assign(async () => new Float32Array([1, 0, 0]), {
      dispose: disposeMock,
    });
    const wasmExtractor = Object.assign(async () => new Float32Array([0, 1, 0]), {
      dispose: disposeMock,
    });

    // First call returns GPU extractor, second returns WASM extractor
    pipelineMock.mockImplementation((_task: string, _model: string, opts: { device: string }) => {
      if (opts.device === 'webgpu') {
        return Promise.resolve(gpuExtractor);
      }
      return Promise.resolve(wasmExtractor);
    });

    const transformers = await import('@huggingface/transformers');
    const mockedEnv = transformers.env as {
      allowRemoteModels: boolean;
      backends?: { onnx?: { webgpu?: { device?: unknown } } };
    };
    mockedEnv.backends = {
      onnx: {
        webgpu: {
          device: {
            createCommandEncoder: () => ({ finish: () => ({}) }),
            lost,
            queue: { submit: vi.fn() },
          },
        },
      },
    };

    const closeMock = vi.fn();
    vi.stubGlobal('self', {
      close: closeMock,
      onerror: undefined,
      onunhandledrejection: undefined,
    });

    const runEmbedding = await loadWorker();

    // Load a webgpu pipeline
    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'gpu-1',
      model: 'gpu-model',
      texts: ['hello'],
      type: 'embed',
    });

    // Load a wasm pipeline
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'wasm-1',
      model: 'wasm-model',
      texts: ['hello'],
      type: 'embed',
    });

    // Trigger device loss which calls invalidateWebGpuPipelines
    resolveLost?.({ message: 'device lost', reason: 'destroyed' });
    await Promise.resolve();
    await Promise.resolve();

    // After invalidation, GPU pipeline should require reload
    pipelineMock.mockClear();
    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'gpu-2',
      model: 'gpu-model',
      texts: ['again'],
      type: 'embed',
    });
    // GPU pipeline was invalidated, so pipeline() should be called again
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    // WASM pipeline should still be cached
    pipelineMock.mockClear();
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'wasm-2',
      model: 'wasm-model',
      texts: ['again'],
      type: 'embed',
    });
    // WASM pipeline still cached, pipeline() should NOT be called
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('loadPipeline updates lastUsedAt on cache hit', async () => {
    vi.useFakeTimers({ now: 1000 });

    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    // First load
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'lru-1',
      model: 'test-model',
      texts: ['hello'],
      type: 'embed',
    });

    // Advance time
    vi.advanceTimersByTime(5000);

    // Second load (cache hit) — should update lastUsedAt
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'lru-2',
      model: 'test-model',
      texts: ['world'],
      type: 'embed',
    });

    // Verify it was a cache hit (pipeline() called only once)
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('emits pipeline cache diagnostics for cache load and hit timestamps', async () => {
    vi.useFakeTimers({ now: 1000 });
    vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}pool-worker-a`);

    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      deviceHint: 'wasm',
      estimatedModelBytes: 300 * 1024 * 1024,
      id: 'cache-diagnostics-load',
      model: 'diagnostic-model',
      texts: ['hello'],
      type: 'embed',
    });

    vi.advanceTimersByTime(5000);

    await runEmbedding({
      deviceHint: 'wasm',
      id: 'cache-diagnostics-hit',
      model: 'diagnostic-model',
      texts: ['world'],
      type: 'embed',
    });

    const diagnostics = workerEmitMock.mock.calls
      .map(([event]) => event)
      .filter((event) => event?.type === 'diagnostic' && event.diagnostic === 'pipeline-cache');

    expect(diagnostics).toEqual([
      expect.objectContaining({
        cacheSize: 1,
        diagnostic: 'pipeline-cache',
        entries: [
          expect.objectContaining({
            cacheKey: 'diagnostic-model|wasm|fp16',
            createdAt: 0,
            device: 'wasm',
            dtype: 'fp16',
            lastUsedAt: 0,
            memory: {
              gpuBytes: 0,
              heapBytes: 300 * 1024 * 1024,
              reason: 'model-size-estimate',
            },
            model: 'diagnostic-model',
          }),
        ],
        event: 'loaded',
        id: 'cache-diagnostics-load',
        type: 'diagnostic',
        workerInstanceId: 'pool-worker-a',
      }),
      expect.objectContaining({
        cacheSize: 1,
        diagnostic: 'pipeline-cache',
        entry: expect.objectContaining({
          cacheKey: 'diagnostic-model|wasm|fp16',
          createdAt: 0,
          lastUsedAt: 5000,
          residencyMs: 5000,
        }),
        event: 'hit',
        id: 'cache-diagnostics-hit',
        type: 'diagnostic',
        workerInstanceId: 'pool-worker-a',
      }),
    ]);
  });

  it('broadcasts idle cache eviction telemetry outside a workerpool request', async () => {
    vi.useFakeTimers({ now: 1000 });
    vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}pool-worker-idle`);
    vi.stubGlobal('location', {
      hash: `#${EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY}=pool-idle-telemetry`,
    });
    const channelMessages: unknown[] = [];
    class MockBroadcastChannel {
      constructor(readonly name: string) {}

      postMessage(message: unknown): void {
        channelMessages.push(message);
      }
    }
    vi.stubGlobal(
      'BroadcastChannel',
      MockBroadcastChannel as unknown as typeof globalThis.BroadcastChannel
    );
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      deviceHint: 'wasm',
      id: 'idle-cache-load',
      model: 'idle-cache-model',
      texts: ['hello'],
      type: 'embed',
    });
    workerEmitMock.mockClear();

    await vi.advanceTimersByTimeAsync(330_000);

    expect(channelMessages).toContainEqual(
      expect.objectContaining({
        cacheSize: 0,
        event: 'evicted',
        reason: 'idle-timeout',
        type: 'diagnostic',
        workerInstanceId: 'pool-worker-idle',
      })
    );
    expect(workerEmitMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'evicted', reason: 'idle-timeout' })
    );
  });

  it('reports idle direct-worker disposal failure through the owner-visible error channel', async () => {
    vi.useFakeTimers({ now: 1000 });
    const postMessage = vi.fn();
    const reportError = vi.fn();
    const mockSelf = {
      close: vi.fn(),
      onerror: null as ((event: ErrorEvent | string) => void) | null,
      onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal('self', mockSelf);
    vi.stubGlobal('reportError', reportError);
    const disposalError = new Error('idle direct release failed');
    const { disposeMock, extractor } = makeExtractor('idle-direct-model');
    disposeMock.mockRejectedValue(disposalError);
    pipelineMock.mockResolvedValue(extractor);
    const runEmbedding = await loadWorker();

    await runEmbedding({
      deviceHint: 'wasm',
      id: 'idle-direct-cache-load',
      model: 'idle-direct-model',
      texts: ['hello'],
      type: 'embed',
    });
    await vi.advanceTimersByTimeAsync(330_000);

    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cause: disposalError,
        message:
          'Embedding pipeline disposal failed for idle-direct-model|wasm|fp16 (idle-timeout).',
      })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'evicted', reason: 'idle-timeout' }),
      []
    );
  });

  it('keeps inference available when cached model-size telemetry changes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      deviceHint: 'wasm',
      estimatedModelBytes: 100,
      id: 'size-first',
      model: 'size-model',
      texts: ['hello'],
      type: 'embed',
    });
    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        estimatedModelBytes: 200,
        id: 'size-second',
        model: 'size-model',
        texts: ['world'],
        type: 'embed',
      })
    ).resolves.toMatchObject({ vectors: expect.any(Array) });

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[EmbeddingWorker]',
      'Embedding model size metadata changed for a cached pipeline; keeping the original estimate',
      expect.objectContaining({ cachedBytes: 100, requestedBytes: 200 })
    );
  });

  it('labels missing model-size metadata separately from runtime memory support', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      deviceHint: 'wasm',
      id: 'size-unknown',
      model: 'unknown-size-model',
      texts: ['hello'],
      type: 'embed',
    });

    expect(workerEmitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            memory: expect.objectContaining({ reason: 'model-size-unknown' }),
          }),
        ],
        event: 'loaded',
      })
    );
  });

  it('keeps unknown model-size attribution immutable across cache hits', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      deviceHint: 'wasm',
      id: 'size-unknown-first',
      model: 'unknown-size-model',
      texts: ['hello'],
      type: 'embed',
    });
    workerEmitMock.mockClear();

    await runEmbedding({
      deviceHint: 'wasm',
      estimatedModelBytes: 1024,
      id: 'size-known-later',
      model: 'unknown-size-model',
      texts: ['world'],
      type: 'embed',
    });

    expect(workerEmitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          memory: {
            gpuBytes: null,
            heapBytes: null,
            reason: 'model-size-unknown',
          },
        }),
        event: 'hit',
      })
    );
  });

  it('loadPipeline removes entry on failure so retry works', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('network error'));
    const runEmbedding = await loadWorker();

    // First attempt fails
    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'retry-1',
        model: 'flaky-model',
        texts: ['hello'],
        type: 'embed',
      })
    ).rejects.toThrow('network error');

    // Second attempt should retry (not return cached rejection)
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const result = await runEmbedding({
      deviceHint: 'wasm',
      id: 'retry-2',
      model: 'flaky-model',
      texts: ['hello'],
      type: 'embed',
    });
    expect(result.vectors).toHaveLength(1);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('blocks replacement allocation and broadcasts lifetime failure when disposal rejects', async () => {
    vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}pool-worker-disposal-failure`);
    vi.stubGlobal('location', {
      hash: `#${EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY}=pool-disposal-failure-telemetry`,
    });
    const channelMessages: unknown[] = [];
    class MockBroadcastChannel {
      constructor(readonly name: string) {}

      postMessage(message: unknown): void {
        channelMessages.push(message);
      }
    }
    vi.stubGlobal(
      'BroadcastChannel',
      MockBroadcastChannel as unknown as typeof globalThis.BroadcastChannel
    );
    const disposalError = new Error('physical release failed');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pipelineMock.mockImplementation((_task: string, model: string) => {
      const { disposeMock, extractor } = makeExtractor(model);
      if (model === 'dispose-fail-a') {
        disposeMock.mockRejectedValue(disposalError);
      }
      return Promise.resolve(extractor);
    });
    const runEmbedding = await loadWorker();

    for (const model of ['dispose-fail-a', 'dispose-fail-b', 'dispose-fail-c']) {
      await runEmbedding({
        deviceHint: 'wasm',
        id: `load-${model}`,
        model,
        texts: ['hello'],
        type: 'embed',
      });
    }

    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'blocked-replacement',
        model: 'dispose-fail-d',
        texts: ['hello'],
        type: 'embed',
      })
    ).rejects.toBe(disposalError);

    expect(pipelineMock.mock.calls.map(([, model]) => model)).not.toContain('dispose-fail-d');
    expect(workerEmitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'blocked-replacement',
        message: 'physical release failed',
        type: 'error',
      })
    );
    expect(channelMessages).toContainEqual({
      cause: 'physical release failed',
      message: 'Embedding pipeline disposal failed for dispose-fail-a|wasm|fp16 (resident-limit).',
      type: 'worker-lifetime-error',
      workerInstanceId: 'pool-worker-disposal-failure',
    });
    expect(errorLog).toHaveBeenCalledWith(
      '[EmbeddingWorker]',
      'Embedding pipeline disposal failed for dispose-fail-a|wasm|fp16 (resident-limit).',
      { cause: 'physical release failed' }
    );
  });

  it('rejects pending WebGPU eviction, then retries after the failed load releases capacity', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    await installMockOrtWebGpuDevice();
    const pendingRaceLoads: ReturnType<
      typeof createDeferred<ReturnType<typeof makeExtractor>['extractor']>
    >[] = [];

    pipelineMock.mockImplementation((_task: string, model: string) => {
      if (model === 'race-model') {
        const deferred = createDeferred<ReturnType<typeof makeExtractor>['extractor']>();
        pendingRaceLoads.push(deferred);
        return deferred.promise;
      }
      return Promise.resolve(makeExtractor(model).extractor);
    });

    const runEmbedding = await loadWorker();

    const firstRace = runEmbedding({
      deviceHint: 'webgpu',
      id: 'race-1',
      model: 'race-model',
      texts: ['first'],
      type: 'embed',
    });
    const firstRaceOutcome = firstRace.catch((error: unknown) => error);
    await vi.waitFor(() => expect(pendingRaceLoads).toHaveLength(1));

    await expect(
      runEmbedding({
        deviceHint: 'webgpu',
        id: 'evictor-blocked',
        model: 'evictor-model',
        texts: ['evict'],
        type: 'embed',
      })
    ).rejects.toThrow(
      'Embedding pipeline cache cannot admit a webgpu load because every resident slot is pending.'
    );
    expect(pipelineMock).not.toHaveBeenCalledWith(
      'feature-extraction',
      'evictor-model',
      expect.anything()
    );

    pendingRaceLoads[0]?.reject(new Error('stale load failed'));
    await expect(firstRaceOutcome).resolves.toMatchObject({ message: 'stale load failed' });
    await expect(
      runEmbedding({
        deviceHint: 'webgpu',
        id: 'evictor-retry',
        model: 'evictor-model',
        texts: ['evict'],
        type: 'embed',
      })
    ).resolves.toMatchObject({ vectors: [new Float32Array([1, 0, 0])] });

    const replacementRace = runEmbedding({
      deviceHint: 'webgpu',
      id: 'race-2',
      model: 'race-model',
      texts: ['replacement'],
      type: 'embed',
    });
    await vi.waitFor(() => expect(pendingRaceLoads).toHaveLength(2));

    pendingRaceLoads[1]?.resolve(makeExtractor('race-replacement').extractor);
    await expect(replacementRace).resolves.toMatchObject({
      vectors: [new Float32Array([1, 0, 0])],
    });

    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'race-3',
      model: 'race-model',
      texts: ['cached'],
      type: 'embed',
    });

    const raceLoads = pipelineMock.mock.calls.filter(([, model]) => model === 'race-model');
    expect(raceLoads).toHaveLength(2);
  });
});
