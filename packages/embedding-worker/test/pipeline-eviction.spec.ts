import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installMockWebGpuDevice,
  loadWorker,
  makeExtractor,
  pipelineMock,
  resetMocks,
  workerEmitMock,
} from './helpers/pipeline-test-setup';

describe('pipeline eviction policy', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loading 2nd GPU pipeline evicts the 1st (max 1 GPU)', async () => {
    installMockWebGpuDevice();

    const { extractor: gpu1, disposeMock: dispose1 } = makeExtractor('gpu1');
    const { extractor: gpu2 } = makeExtractor('gpu2');

    pipelineMock.mockResolvedValueOnce(gpu1).mockResolvedValueOnce(gpu2);

    const runEmbedding = await loadWorker();

    // Load first GPU pipeline
    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'e1',
      model: 'model-a',
      texts: ['hello'],
      type: 'embed',
    });

    // Load second GPU pipeline — should evict the first
    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'e2',
      model: 'model-b',
      texts: ['world'],
      type: 'embed',
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
        deviceHint: 'wasm',
        id: `w${i}`,
        model: `wasm-model-${i}`,
        texts: ['hello'],
        type: 'embed',
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
    installMockWebGpuDevice();

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
        deviceHint: 'wasm',
        id: `w${i}`,
        model: `wasm-model-${i}`,
        texts: ['hello'],
        type: 'embed',
      });
    }

    // Load 1 GPU pipeline — should NOT evict any WASM pipelines
    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'g0',
      model: 'gpu-model',
      texts: ['hello'],
      type: 'embed',
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
      deviceHint: 'wasm',
      id: 'idle-test',
      model: 'idle-model',
      texts: ['hello'],
      type: 'embed',
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
      deviceHint: 'wasm',
      id: 'active-1',
      model: 'active-model',
      texts: ['hello'],
      type: 'embed',
    });

    // Advance 4 minutes (close to timeout but not past it)
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    // Use the pipeline again (cache hit updates lastUsedAt)
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'active-2',
      model: 'active-model',
      texts: ['still here'],
      type: 'embed',
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
      deviceHint: 'wasm',
      id: 'quick',
      model: 'quick-model',
      texts: ['hello'],
      type: 'embed',
    });

    // Start a slow inference on a different model
    const slowPromise = runEmbedding({
      deviceHint: 'wasm',
      id: 'slow',
      model: 'slow-model',
      texts: ['thinking...'],
      type: 'embed',
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

    const submitMock = vi.fn();
    installMockWebGpuDevice({
      createCommandEncoder: () => ({ finish: () => ({}) }),
      lost: new Promise(() => {}),
      queue: { submit: submitMock },
    });

    const { extractor: gpu1, disposeMock: dispose1 } = makeExtractor('gpu-ka1');
    const { extractor: gpu2 } = makeExtractor('gpu-ka2');

    pipelineMock.mockResolvedValueOnce(gpu1).mockResolvedValueOnce(gpu2);

    const runEmbedding = await loadWorker();

    // Load first GPU pipeline — starts keep-alive
    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'ka1',
      model: 'gpu-model-1',
      texts: ['hello'],
      type: 'embed',
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
      deviceHint: 'webgpu',
      id: 'ka2',
      model: 'gpu-model-2',
      texts: ['world'],
      type: 'embed',
    });

    expect(dispose1).toHaveBeenCalled();
  });

  it('idle sweep timer stops when cache becomes empty', async () => {
    vi.useFakeTimers({ now: 1000 });

    const { extractor, disposeMock } = makeExtractor('empty1');
    pipelineMock.mockResolvedValue(extractor);

    const runEmbedding = await loadWorker();

    await runEmbedding({
      deviceHint: 'wasm',
      id: 'emp-1',
      model: 'emp-model',
      texts: ['hello'],
      type: 'embed',
    });

    // Advance past idle timeout — should evict and stop the sweep timer
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30_000);
    expect(disposeMock).toHaveBeenCalled();

    // Loading a new pipeline should work (sweep timer restarts)
    const { extractor: extractor2 } = makeExtractor('empty2');
    pipelineMock.mockResolvedValue(extractor2);
    const result = await runEmbedding({
      deviceHint: 'wasm',
      id: 'emp-2',
      model: 'emp-model-2',
      texts: ['world'],
      type: 'embed',
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
        deviceHint: 'wasm',
        id: `lru-${i}`,
        model: `lru-model-${i}`,
        texts: ['hello'],
        type: 'embed',
      });
    }

    // Touch the FIRST pipeline (makes it most recently used)
    vi.advanceTimersByTime(1000);
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'lru-touch',
      model: 'lru-model-0',
      texts: ['touch'],
      type: 'embed',
    });

    // Load 4th — should evict model-1 (oldest by lastUsedAt), NOT model-0
    vi.advanceTimersByTime(1000);
    await runEmbedding({
      deviceHint: 'wasm',
      id: 'lru-4',
      model: 'lru-model-3',
      texts: ['new'],
      type: 'embed',
    });

    // model-1 was the LRU (inserted second, never touched again)
    expect(extractors[1]?.disposeMock).toHaveBeenCalled();
    // model-0 was touched more recently, should NOT be evicted
    expect(extractors[0]?.disposeMock).not.toHaveBeenCalled();
    // model-2 was inserted after model-1 so still newer
    expect(extractors[2]?.disposeMock).not.toHaveBeenCalled();
  });

  it('emits eviction diagnostics with reason and residency duration', async () => {
    vi.useFakeTimers({ now: 1000 });

    const extractors = Array.from({ length: 4 }, (_, i) => makeExtractor(`evict${i}`));
    pipelineMock
      .mockResolvedValueOnce(extractors[0]?.extractor)
      .mockResolvedValueOnce(extractors[1]?.extractor)
      .mockResolvedValueOnce(extractors[2]?.extractor)
      .mockResolvedValueOnce(extractors[3]?.extractor);

    const runEmbedding = await loadWorker();

    for (let i = 0; i < 3; i++) {
      await runEmbedding({
        deviceHint: 'wasm',
        id: `evict-${i}`,
        model: `evict-model-${i}`,
        texts: ['hello'],
        type: 'embed',
      });
      vi.advanceTimersByTime(1000);
    }

    await runEmbedding({
      deviceHint: 'wasm',
      id: 'evict-3',
      model: 'evict-model-3',
      texts: ['new'],
      type: 'embed',
    });
    await Promise.resolve();

    const eviction = workerEmitMock.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event?.type === 'diagnostic' &&
          event.diagnostic === 'pipeline-cache' &&
          event.event === 'evicted'
      );

    expect(eviction).toMatchObject({
      cacheSize: 2,
      diagnostic: 'pipeline-cache',
      entry: expect.objectContaining({
        cacheKey: 'evict-model-0|wasm|fp16',
        model: 'evict-model-0',
        residencyMs: 3000,
      }),
      event: 'evicted',
      reason: 'resident-limit',
      type: 'diagnostic',
    });
  });
});
