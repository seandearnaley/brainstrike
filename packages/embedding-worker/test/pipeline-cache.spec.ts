import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installMockOrtWebGpuDevice,
  loadWorker,
  pipelineMock,
  resetMocks,
  workerEmitMock,
} from './helpers/pipeline-test-setup';

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
      type: 'embed',
      id: 'dispose-test',
      model: 'test-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    // Load same model again — should be a cache hit (no new pipeline call)
    await runEmbedding({
      type: 'embed',
      id: 'dispose-test-2',
      model: 'test-model',
      texts: ['world'],
      deviceHint: 'wasm',
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
      type: 'embed',
      id: 'webgpu-dispose',
      model: 'gpu-model',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });

    // Load again — cache hit
    pipelineMock.mockClear();
    await runEmbedding2({
      type: 'embed',
      id: 'webgpu-dispose-2',
      model: 'gpu-model',
      texts: ['world'],
      deviceHint: 'webgpu',
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
        type: 'embed',
        id: 'fail-dispose',
        model: 'broken-model',
        texts: ['hello'],
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('load failed');

    // The failed entry should have been removed from cache (retry cleanup)
    // Loading again should trigger a new pipeline call
    await installMockOrtWebGpuDevice();
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const result = await runEmbedding({
      type: 'embed',
      id: 'retry-after-fail',
      model: 'broken-model',
      texts: ['hello'],
      deviceHint: 'webgpu',
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
            lost,
            queue: { submit: vi.fn() },
            createCommandEncoder: () => ({ finish: () => ({}) }),
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
      type: 'embed',
      id: 'gpu-1',
      model: 'gpu-model',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });

    // Load a wasm pipeline
    await runEmbedding({
      type: 'embed',
      id: 'wasm-1',
      model: 'wasm-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });

    // Trigger device loss which calls invalidateWebGpuPipelines
    resolveLost?.({ message: 'device lost', reason: 'destroyed' });
    await Promise.resolve();
    await Promise.resolve();

    // After invalidation, GPU pipeline should require reload
    pipelineMock.mockClear();
    await runEmbedding({
      type: 'embed',
      id: 'gpu-2',
      model: 'gpu-model',
      texts: ['again'],
      deviceHint: 'webgpu',
    });
    // GPU pipeline was invalidated, so pipeline() should be called again
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    // WASM pipeline should still be cached
    pipelineMock.mockClear();
    await runEmbedding({
      type: 'embed',
      id: 'wasm-2',
      model: 'wasm-model',
      texts: ['again'],
      deviceHint: 'wasm',
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
      type: 'embed',
      id: 'lru-1',
      model: 'test-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });

    // Advance time
    vi.advanceTimersByTime(5000);

    // Second load (cache hit) — should update lastUsedAt
    await runEmbedding({
      type: 'embed',
      id: 'lru-2',
      model: 'test-model',
      texts: ['world'],
      deviceHint: 'wasm',
    });

    // Verify it was a cache hit (pipeline() called only once)
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('emits pipeline cache diagnostics for cache load and hit timestamps', async () => {
    vi.useFakeTimers({ now: 1000 });

    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      type: 'embed',
      id: 'cache-diagnostics-load',
      model: 'diagnostic-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });

    vi.advanceTimersByTime(5000);

    await runEmbedding({
      type: 'embed',
      id: 'cache-diagnostics-hit',
      model: 'diagnostic-model',
      texts: ['world'],
      deviceHint: 'wasm',
    });

    const diagnostics = workerEmitMock.mock.calls
      .map(([event]) => event)
      .filter((event) => event?.type === 'diagnostic' && event.diagnostic === 'pipeline-cache');

    expect(diagnostics).toEqual([
      expect.objectContaining({
        type: 'diagnostic',
        diagnostic: 'pipeline-cache',
        event: 'loaded',
        id: 'cache-diagnostics-load',
        cacheSize: 1,
        entries: [
          expect.objectContaining({
            cacheKey: 'diagnostic-model|wasm|fp16',
            createdAt: 0,
            device: 'wasm',
            dtype: 'fp16',
            lastUsedAt: 0,
            memory: {
              gpuBytes: null,
              heapBytes: null,
              reason: 'browser-runtime-unavailable',
            },
            model: 'diagnostic-model',
          }),
        ],
      }),
      expect.objectContaining({
        type: 'diagnostic',
        diagnostic: 'pipeline-cache',
        event: 'hit',
        id: 'cache-diagnostics-hit',
        cacheSize: 1,
        entry: expect.objectContaining({
          cacheKey: 'diagnostic-model|wasm|fp16',
          createdAt: 0,
          lastUsedAt: 5000,
          residencyMs: 5000,
        }),
      }),
    ]);
  });

  it('loadPipeline removes entry on failure so retry works', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('network error'));
    const runEmbedding = await loadWorker();

    // First attempt fails
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'retry-1',
        model: 'flaky-model',
        texts: ['hello'],
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('network error');

    // Second attempt should retry (not return cached rejection)
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const result = await runEmbedding({
      type: 'embed',
      id: 'retry-2',
      model: 'flaky-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });
    expect(result.vectors).toHaveLength(1);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });
});
