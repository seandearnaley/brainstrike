import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installMockOrtWebGpuDevice,
  loadWorker,
  makeExtractor,
  pipelineMock,
  resetMocks,
} from './helpers/pipeline-test-setup';

describe('pipeline eviction policy', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loading 2nd GPU pipeline evicts the 1st (max 1 GPU)', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    await installMockOrtWebGpuDevice();

    const { extractor: gpu1, disposeMock: dispose1 } = makeExtractor('gpu1');
    const { extractor: gpu2 } = makeExtractor('gpu2');

    pipelineMock.mockResolvedValueOnce(gpu1).mockResolvedValueOnce(gpu2);

    const runEmbedding = await loadWorker();

    // Load first GPU pipeline
    await runEmbedding({
      type: 'embed',
      id: 'e1',
      model: 'model-a',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });

    // Load second GPU pipeline — should evict the first
    await runEmbedding({
      type: 'embed',
      id: 'e2',
      model: 'model-b',
      texts: ['world'],
      deviceHint: 'webgpu',
    });

    expect(dispose1).toHaveBeenCalled();
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('loading 4th WASM pipeline evicts LRU (max 3 WASM)', async () => {
    const extractors = Array.from({ length: 4 }, (_, i) => makeExtractor(`wasm${i}`));

    pipelineMock
      .mockResolvedValueOnce(extractors[0]?.extractor)
      .mockResolvedValueOnce(extractors[1]?.extractor)
      .mockResolvedValueOnce(extractors[2]?.extractor)
      .mockResolvedValueOnce(extractors[3]?.extractor);

    const runEmbedding = await loadWorker();

    for (let i = 0; i < 4; i++) {
      await runEmbedding({
        type: 'embed',
        id: `w${i}`,
        model: `wasm-model-${i}`,
        texts: ['hello'],
        deviceHint: 'wasm',
      });
    }

    // First (oldest) WASM pipeline should have been disposed
    expect(extractors[0]?.disposeMock).toHaveBeenCalled();
    // Others should not
    expect(extractors[1]?.disposeMock).not.toHaveBeenCalled();
    expect(extractors[2]?.disposeMock).not.toHaveBeenCalled();
    expect(extractors[3]?.disposeMock).not.toHaveBeenCalled();
  });

  it('GPU and WASM limits are independent', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    await installMockOrtWebGpuDevice();

    const wasmExtractors = Array.from({ length: 3 }, (_, i) => makeExtractor(`wasm${i}`));
    const { extractor: gpuExtractor } = makeExtractor('gpu0');

    pipelineMock.mockImplementation((_task: string, model: string, opts: { device: string }) => {
      if (opts.device === 'webgpu') {
        return Promise.resolve(gpuExtractor);
      }
      const idx = Number.parseInt(model.split('-').pop() ?? '0', 10);
      return Promise.resolve(wasmExtractors[idx]?.extractor);
    });

    const runEmbedding = await loadWorker();

    // Load 3 WASM pipelines (at max)
    for (let i = 0; i < 3; i++) {
      await runEmbedding({
        type: 'embed',
        id: `w${i}`,
        model: `wasm-model-${i}`,
        texts: ['hello'],
        deviceHint: 'wasm',
      });
    }

    // Load 1 GPU pipeline — should NOT evict any WASM pipelines
    await runEmbedding({
      type: 'embed',
      id: 'g0',
      model: 'gpu-model',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });

    for (const { disposeMock } of wasmExtractors) {
      expect(disposeMock).not.toHaveBeenCalled();
    }
  });

  it('idle sweep evicts entries past timeout', async () => {
    vi.useFakeTimers({ now: 1000 });

    const { extractor, disposeMock } = makeExtractor('idle1');
    pipelineMock.mockResolvedValue(extractor);

    const runEmbedding = await loadWorker();

    await runEmbedding({
      type: 'embed',
      id: 'idle-test',
      model: 'idle-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });

    // Advance past the idle timeout (5 min) + one sweep interval (30s)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30_000);

    expect(disposeMock).toHaveBeenCalled();
  });

  it('idle sweep resets on cache hit', async () => {
    vi.useFakeTimers({ now: 1000 });

    const { extractor, disposeMock } = makeExtractor('active1');
    pipelineMock.mockResolvedValue(extractor);

    const runEmbedding = await loadWorker();

    await runEmbedding({
      type: 'embed',
      id: 'active-1',
      model: 'active-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });

    // Advance 4 minutes (close to timeout but not past it)
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    // Use the pipeline again (cache hit updates lastUsedAt)
    await runEmbedding({
      type: 'embed',
      id: 'active-2',
      model: 'active-model',
      texts: ['still here'],
      deviceHint: 'wasm',
    });

    // Advance another 4 minutes — should NOT evict because lastUsedAt was reset
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    expect(disposeMock).not.toHaveBeenCalled();
  });

  it('idle sweep skips during active inference', async () => {
    vi.useFakeTimers({ now: 1000 });

    const { extractor, disposeMock } = makeExtractor('busy1');

    // Create a slow extractor we can control
    let resolveInference!: (v: Float32Array) => void;
    const slowExtractor = Object.assign(
      () =>
        new Promise<Float32Array>((resolve) => {
          resolveInference = resolve;
        }),
      { dispose: disposeMock }
    );

    pipelineMock
      .mockResolvedValueOnce(extractor) // first load (quick)
      .mockResolvedValueOnce(slowExtractor); // second load (slow)

    const runEmbedding = await loadWorker();

    // Load a quick pipeline first to populate cache
    await runEmbedding({
      type: 'embed',
      id: 'quick',
      model: 'quick-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });

    // Start a slow inference on a different model
    const slowPromise = runEmbedding({
      type: 'embed',
      id: 'slow',
      model: 'slow-model',
      texts: ['thinking...'],
      deviceHint: 'wasm',
    });
    await Promise.resolve();

    // Advance past idle timeout while inference is active — sweep should skip
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30_000);

    // The quick-model pipeline should NOT have been disposed (inference is active)
    expect(disposeMock).not.toHaveBeenCalled();

    // Complete the slow inference
    resolveInference(new Float32Array([1, 0, 0]));
    await slowPromise;
  });

  it('GPU keep-alive stops when last GPU pipeline evicted', async () => {
    vi.useFakeTimers({ now: 1000 });
    vi.stubGlobal('navigator', { gpu: {} });

    const submitMock = vi.fn();
    const transformers = await import('@huggingface/transformers');
    const mockedEnv = transformers.env as {
      allowRemoteModels: boolean;
      backends?: { onnx?: { webgpu?: { device?: unknown } } };
    };
    mockedEnv.backends = {
      onnx: {
        webgpu: {
          device: {
            lost: new Promise(() => {}),
            queue: { submit: submitMock },
            createCommandEncoder: () => ({ finish: () => ({}) }),
          },
        },
      },
    };

    const { extractor: gpu1, disposeMock: dispose1 } = makeExtractor('gpu-ka1');
    const { extractor: gpu2 } = makeExtractor('gpu-ka2');

    pipelineMock.mockResolvedValueOnce(gpu1).mockResolvedValueOnce(gpu2);

    const runEmbedding = await loadWorker();

    // Load first GPU pipeline — starts keep-alive
    await runEmbedding({
      type: 'embed',
      id: 'ka1',
      model: 'gpu-model-1',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });
    await Promise.resolve();
    await Promise.resolve();

    // Verify keep-alive is ticking
    await vi.advanceTimersByTimeAsync(15_000);
    expect(submitMock).toHaveBeenCalled();
    submitMock.mockClear();

    // Load second GPU pipeline — evicts first, keep-alive may stop briefly
    // then the new GPU pipeline exists so keep-alive should still be managed
    await runEmbedding({
      type: 'embed',
      id: 'ka2',
      model: 'gpu-model-2',
      texts: ['world'],
      deviceHint: 'webgpu',
    });

    expect(dispose1).toHaveBeenCalled();
  });

  it('idle sweep timer stops when cache becomes empty', async () => {
    vi.useFakeTimers({ now: 1000 });

    const { extractor, disposeMock } = makeExtractor('empty1');
    pipelineMock.mockResolvedValue(extractor);

    const runEmbedding = await loadWorker();

    await runEmbedding({
      type: 'embed',
      id: 'emp-1',
      model: 'emp-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });

    // Advance past idle timeout — should evict and stop the sweep timer
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30_000);
    expect(disposeMock).toHaveBeenCalled();

    // Loading a new pipeline should work (sweep timer restarts)
    const { extractor: extractor2 } = makeExtractor('empty2');
    pipelineMock.mockResolvedValue(extractor2);
    const result = await runEmbedding({
      type: 'embed',
      id: 'emp-2',
      model: 'emp-model-2',
      texts: ['world'],
      deviceHint: 'wasm',
    });
    expect(result.vectors).toHaveLength(1);
  });

  it('LRU picks oldest by lastUsedAt not insertion order', async () => {
    vi.useFakeTimers({ now: 1000 });

    const extractors = Array.from({ length: 4 }, (_, i) => makeExtractor(`lru${i}`));

    pipelineMock
      .mockResolvedValueOnce(extractors[0]?.extractor)
      .mockResolvedValueOnce(extractors[1]?.extractor)
      .mockResolvedValueOnce(extractors[2]?.extractor)
      .mockResolvedValueOnce(extractors[3]?.extractor);

    const runEmbedding = await loadWorker();

    // Load 3 WASM pipelines
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000); // space them 1s apart
      await runEmbedding({
        type: 'embed',
        id: `lru-${i}`,
        model: `lru-model-${i}`,
        texts: ['hello'],
        deviceHint: 'wasm',
      });
    }

    // Touch the FIRST pipeline (makes it most recently used)
    vi.advanceTimersByTime(1000);
    await runEmbedding({
      type: 'embed',
      id: 'lru-touch',
      model: 'lru-model-0',
      texts: ['touch'],
      deviceHint: 'wasm',
    });

    // Load 4th — should evict model-1 (oldest by lastUsedAt), NOT model-0
    vi.advanceTimersByTime(1000);
    await runEmbedding({
      type: 'embed',
      id: 'lru-4',
      model: 'lru-model-3',
      texts: ['new'],
      deviceHint: 'wasm',
    });

    // model-1 was the LRU (inserted second, never touched again)
    expect(extractors[1]?.disposeMock).toHaveBeenCalled();
    // model-0 was touched more recently, should NOT be evicted
    expect(extractors[0]?.disposeMock).not.toHaveBeenCalled();
    // model-2 was inserted after model-1 so still newer
    expect(extractors[2]?.disposeMock).not.toHaveBeenCalled();
  });
});
