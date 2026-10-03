import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertEmbeddingTelemetrySnapshot,
  createEmptyEmbeddingTelemetrySnapshot,
  getEmbeddingTelemetrySnapshot,
  recordEmbeddingBatchTelemetry,
  recordEmbeddingPipelineCacheTelemetry,
  recordEmbeddingTelemetryFailure,
  removeEmbeddingTelemetrySource,
  resetEmbeddingTelemetryForTests,
  subscribeEmbeddingTelemetry,
  subscribeEmbeddingTelemetryThrottled,
} from '../src/embedding-telemetry';
import type { EmbedWorkerBatch, EmbedWorkerPipelineCacheDiagnostic } from '../src/shared';

describe('embedding telemetry store', () => {
  beforeEach(() => {
    resetEmbeddingTelemetryForTests();
  });

  it('preserves q8 WASM residency at the host snapshot boundary', () => {
    const entry = {
      cacheKey: 'fused|wasm|q8',
      createdAt: 1,
      device: 'wasm',
      dtype: 'q8',
      lastUsedAt: 100,
      memory: { gpuBytes: 0, heapBytes: 23, reason: 'model-size-estimate' },
      model: 'fused',
      residencyMs: 99,
    } as const;
    recordEmbeddingPipelineCacheTelemetry('worker-q8', {
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 100,
      entries: [entry],
      entry,
      event: 'loaded',
      type: 'diagnostic',
      workerInstanceId: 'worker-q8',
    });
    const snapshot = getEmbeddingTelemetrySnapshot();
    expect(() => assertEmbeddingTelemetrySnapshot(snapshot)).not.toThrow();
    expect(snapshot.cache.entries[0]).toMatchObject({ device: 'wasm', dtype: 'q8' });
  });

  it('aggregates exact worker transfer bytes and peak vectors in flight', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEmbeddingTelemetry(listener);

    recordEmbeddingBatchTelemetry('worker-a', {
      batchIndex: 0,
      endIndex: 2,
      id: 'embed-1',
      peakVectorsInFlight: 2,
      startIndex: 0,
      transferBytes: 24,
      type: 'batch',
      vectors: [new Float32Array(3), new Float32Array(3)],
      vectorsInFlight: 2,
    } satisfies EmbedWorkerBatch);
    recordEmbeddingBatchTelemetry('worker-a', {
      batchIndex: 1,
      endIndex: 3,
      id: 'embed-1',
      peakVectorsInFlight: 3,
      startIndex: 2,
      transferBytes: 12,
      type: 'batch',
      vectors: [new Float32Array(3)],
      vectorsInFlight: 1,
    } satisfies EmbedWorkerBatch);

    expect(getEmbeddingTelemetrySnapshot()).toMatchObject({
      batchTransfer: {
        batchCount: 2,
        lastBytes: 12,
        peakBytes: 24,
        totalBytes: 36,
      },
      peakVectorsInFlight: 3,
    });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('coalesces throttled subscribers while retaining every batch', async () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribeEmbeddingTelemetryThrottled(listener);

    for (let batchIndex = 0; batchIndex < 2; batchIndex += 1) {
      recordEmbeddingBatchTelemetry('worker-a', {
        batchIndex,
        endIndex: batchIndex + 1,
        id: 'embed-1',
        peakVectorsInFlight: 1,
        startIndex: batchIndex,
        transferBytes: 8,
        type: 'batch',
        vectors: [new Float32Array(2)],
        vectorsInFlight: 1,
      } satisfies EmbedWorkerBatch);
    }

    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getEmbeddingTelemetrySnapshot().batchTransfer.batchCount).toBe(2);

    unsubscribe();
    vi.useRealTimers();
  });

  it('retains explicit telemetry failures without fabricating worker samples', () => {
    recordEmbeddingTelemetryFailure(
      'Workerpool result arrived without a pipeline-cache source diagnostic.'
    );

    expect(getEmbeddingTelemetrySnapshot()).toMatchObject({
      batchTransfer: { batchCount: 0 },
      cache: { residentCount: 0 },
      health: {
        failureCount: 1,
        lastFailure: 'Workerpool result arrived without a pipeline-cache source diagnostic.',
      },
    });
    expect(() => recordEmbeddingTelemetryFailure('')).toThrow(
      'Embedding telemetry failure reason must contain 1-240 characters.'
    );
    expect(() => recordEmbeddingTelemetryFailure('x'.repeat(241))).toThrow(
      'Embedding telemetry failure reason must contain 1-240 characters.'
    );
  });

  it('rejects inconsistent telemetry health at the process boundary', () => {
    const empty = createEmptyEmbeddingTelemetrySnapshot();
    expect(() =>
      assertEmbeddingTelemetrySnapshot({
        ...empty,
        health: { failureCount: 1, lastFailure: null },
      })
    ).toThrow(
      'Embedding telemetry health requires lastFailure exactly when failureCount is non-zero.'
    );
    expect(() =>
      assertEmbeddingTelemetrySnapshot({
        ...empty,
        health: { failureCount: 0, lastFailure: 'stale failure' },
      })
    ).toThrow(
      'Embedding telemetry health requires lastFailure exactly when failureCount is non-zero.'
    );
  });

  it.each([
    ['batch count', { batchCount: 1.5, lastBytes: 0, peakBytes: 0, totalBytes: 0 }],
    ['nonempty zero-byte aggregate', { batchCount: 1, lastBytes: 0, peakBytes: 0, totalBytes: 0 }],
    ['undersized batch', { batchCount: 1, lastBytes: 1, peakBytes: 1, totalBytes: 1 }],
    ['undersized total', { batchCount: 2, lastBytes: 4, peakBytes: 4, totalBytes: 4 }],
    ['oversized total', { batchCount: 2, lastBytes: 4, peakBytes: 4, totalBytes: 100 }],
    ['last bytes', { batchCount: 1, lastBytes: 13, peakBytes: 12, totalBytes: 13 }],
    ['peak bytes', { batchCount: 1, lastBytes: 12, peakBytes: 14, totalBytes: 13 }],
    ['empty aggregate', { batchCount: 0, lastBytes: 0, peakBytes: 1, totalBytes: 1 }],
  ])('rejects inconsistent %s telemetry aggregates', (_field, batchTransfer) => {
    expect(() =>
      assertEmbeddingTelemetrySnapshot({
        ...createEmptyEmbeddingTelemetrySnapshot(),
        batchTransfer,
        lastUpdatedAt: 1,
      })
    ).toThrow('Embedding telemetry batchTransfer');
  });

  it('rejects inconsistent cache aggregates at the process boundary', () => {
    const empty = createEmptyEmbeddingTelemetrySnapshot();
    const snapshot = {
      ...empty,
      cache: {
        entries: [
          {
            cacheKey: 'model-a|webgpu|fp16',
            createdAt: 100,
            device: 'webgpu',
            dtype: 'fp16',
            lastUsedAt: 200,
            memory: {
              gpuBytes: 1024,
              heapBytes: 0,
              reason: 'model-size-estimate',
            },
            model: 'model-a',
            residencyMs: 100,
            sourceId: 'worker-a',
          },
          {
            cacheKey: 'model-b|wasm|q4',
            createdAt: 100,
            device: 'wasm',
            dtype: 'q4',
            lastUsedAt: 200,
            memory: {
              gpuBytes: null,
              heapBytes: null,
              reason: 'model-size-unknown',
            },
            model: 'model-b',
            residencyMs: 100,
            sourceId: 'worker-b',
          },
        ],
        estimatedGpuBytes: 1024,
        estimatedHeapBytes: 0,
        memoryEstimateUnavailableCount: 1,
        residentCount: 2,
      },
      lastUpdatedAt: 200,
    } as const;

    const inconsistentAggregates = [
      ['estimatedGpuBytes', 1023],
      ['estimatedHeapBytes', 1],
      ['memoryEstimateUnavailableCount', 0],
      ['residentCount', 1],
    ] as const;

    for (const [field, value] of inconsistentAggregates) {
      expect(() =>
        assertEmbeddingTelemetrySnapshot({
          ...snapshot,
          cache: { ...snapshot.cache, [field]: value },
        })
      ).toThrow(`Embedding telemetry cache.${field} does not match cache.entries.`);
    }
  });

  it('rejects duplicate cache source identities at the process boundary', () => {
    const entry = {
      cacheKey: 'model-a|webgpu|fp16',
      createdAt: 100,
      device: 'webgpu',
      dtype: 'fp16',
      lastUsedAt: 200,
      memory: {
        gpuBytes: 1024,
        heapBytes: 0,
        reason: 'model-size-estimate',
      },
      model: 'model-a',
      residencyMs: 100,
      sourceId: 'worker-a',
    } as const;

    expect(() =>
      assertEmbeddingTelemetrySnapshot({
        ...createEmptyEmbeddingTelemetrySnapshot(),
        cache: {
          entries: [entry, entry],
          estimatedGpuBytes: 2048,
          estimatedHeapBytes: 0,
          memoryEstimateUnavailableCount: 0,
          residentCount: 2,
        },
        lastUpdatedAt: 200,
      })
    ).toThrow('Embedding telemetry cache.entries contains duplicate source/cache identities.');
  });

  it('rejects unsupported cache entry dtypes at the process boundary', () => {
    expect(() =>
      assertEmbeddingTelemetrySnapshot({
        ...createEmptyEmbeddingTelemetrySnapshot(),
        cache: {
          entries: [
            {
              cacheKey: 'model-a|webgpu|int8',
              createdAt: 100,
              device: 'webgpu',
              dtype: 'int8',
              lastUsedAt: 200,
              memory: {
                gpuBytes: 1024,
                heapBytes: 0,
                reason: 'model-size-estimate',
              },
              model: 'model-a',
              residencyMs: 100,
              sourceId: 'worker-a',
            },
          ],
          estimatedGpuBytes: 1024,
          estimatedHeapBytes: 0,
          memoryEstimateUnavailableCount: 0,
          residentCount: 1,
        },
        lastUpdatedAt: 200,
      })
    ).toThrow('Embedding telemetry cache.entries[0].dtype is invalid.');
  });

  it('rejects contradictory cache memory at the process boundary', () => {
    expect(() =>
      assertEmbeddingTelemetrySnapshot({
        ...createEmptyEmbeddingTelemetrySnapshot(),
        cache: {
          entries: [
            {
              cacheKey: 'model-a|wasm|fp32',
              createdAt: 100,
              device: 'wasm',
              dtype: 'fp32',
              lastUsedAt: 200,
              memory: {
                gpuBytes: 1024,
                heapBytes: 0,
                reason: 'model-size-estimate',
              },
              model: 'model-a',
              residencyMs: 100,
              sourceId: 'worker-a',
            },
          ],
          estimatedGpuBytes: 1024,
          estimatedHeapBytes: 0,
          memoryEstimateUnavailableCount: 0,
          residentCount: 1,
        },
        lastUpdatedAt: 200,
      })
    ).toThrow(
      'Embedding telemetry cache.entries[0].memory.gpuBytes must be null or zero for wasm.'
    );
  });

  it('rejects WebGPU model estimates attributed to heap memory', () => {
    expect(() =>
      assertEmbeddingTelemetrySnapshot({
        ...createEmptyEmbeddingTelemetrySnapshot(),
        cache: {
          entries: [
            {
              cacheKey: 'model-a|webgpu|fp16',
              createdAt: 100,
              device: 'webgpu',
              dtype: 'fp16',
              lastUsedAt: 200,
              memory: {
                gpuBytes: 0,
                heapBytes: 1024,
                reason: 'model-size-estimate',
              },
              model: 'model-a',
              residencyMs: 100,
              sourceId: 'worker-a',
            },
          ],
          estimatedGpuBytes: 0,
          estimatedHeapBytes: 1024,
          memoryEstimateUnavailableCount: 0,
          residentCount: 1,
        },
        lastUpdatedAt: 200,
      })
    ).toThrow(
      'Embedding telemetry cache.entries[0].memory must attribute a WebGPU model-size estimate to GPU bytes.'
    );
  });

  it.each([
    [
      'a transferred batch',
      {
        batchTransfer: { batchCount: 1, lastBytes: 8, peakBytes: 8, totalBytes: 8 },
      },
    ],
    [
      'a resident cache entry',
      {
        cache: {
          entries: [
            {
              cacheKey: 'model-a|webgpu|fp16',
              createdAt: 100,
              device: 'webgpu',
              dtype: 'fp16',
              lastUsedAt: 200,
              memory: {
                gpuBytes: 1024,
                heapBytes: 0,
                reason: 'model-size-estimate',
              },
              model: 'model-a',
              residencyMs: 100,
              sourceId: 'worker-a',
            },
          ],
          estimatedGpuBytes: 1024,
          estimatedHeapBytes: 0,
          memoryEstimateUnavailableCount: 0,
          residentCount: 1,
        },
      },
    ],
    [
      'a health failure',
      {
        health: { failureCount: 1, lastFailure: 'worker failed' },
      },
    ],
  ] as const)('requires a mutation timestamp for %s', (_case, mutation) => {
    expect(() =>
      assertEmbeddingTelemetrySnapshot({
        ...createEmptyEmbeddingTelemetrySnapshot(),
        ...mutation,
      })
    ).toThrow('Embedding telemetry lastUpdatedAt is required after an observed mutation.');
  });

  it('tracks resident model bytes by device and removes terminated worker state', () => {
    recordEmbeddingPipelineCacheTelemetry('worker-a', {
      cacheSize: 2,
      diagnostic: 'pipeline-cache',
      emittedAt: 1000,
      entries: [
        {
          cacheKey: 'gpu-model|webgpu|fp16',
          createdAt: 100,
          device: 'webgpu',
          dtype: 'fp16',
          lastUsedAt: 900,
          memory: {
            gpuBytes: 300 * 1024 * 1024,
            heapBytes: 0,
            reason: 'model-size-estimate',
          },
          model: 'gpu-model',
          residencyMs: 900,
        },
        {
          cacheKey: 'wasm-model|wasm|q4',
          createdAt: 200,
          device: 'wasm',
          dtype: 'q4',
          lastUsedAt: 800,
          memory: {
            gpuBytes: 0,
            heapBytes: 23 * 1024 * 1024,
            reason: 'model-size-estimate',
          },
          model: 'wasm-model',
          residencyMs: 800,
        },
      ],
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'worker-a',
    } satisfies EmbedWorkerPipelineCacheDiagnostic);

    expect(getEmbeddingTelemetrySnapshot().cache).toMatchObject({
      estimatedGpuBytes: 300 * 1024 * 1024,
      estimatedHeapBytes: 23 * 1024 * 1024,
      memoryEstimateUnavailableCount: 0,
      residentCount: 2,
    });

    removeEmbeddingTelemetrySource('worker-a');
    expect(getEmbeddingTelemetrySnapshot().cache).toMatchObject({
      estimatedGpuBytes: 0,
      estimatedHeapBytes: 0,
      residentCount: 0,
    });
  });

  it('rejects cache hits that disagree with the tracked resident cache', () => {
    const residentEntry = {
      cacheKey: 'model-a|webgpu|fp16',
      createdAt: 100,
      device: 'webgpu',
      dtype: 'fp16',
      lastUsedAt: 200,
      memory: {
        gpuBytes: 1024,
        heapBytes: 0,
        reason: 'model-size-estimate',
      },
      model: 'model-a',
      residencyMs: 100,
    } as const;
    recordEmbeddingPipelineCacheTelemetry('worker-a', {
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 200,
      entries: [residentEntry],
      event: 'loaded',
      id: 'embed-1',
      type: 'diagnostic',
      workerInstanceId: 'worker-a',
    });

    expect(() =>
      recordEmbeddingPipelineCacheTelemetry('worker-a', {
        cacheSize: 1,
        diagnostic: 'pipeline-cache',
        emittedAt: 300,
        entry: {
          ...residentEntry,
          cacheKey: 'model-b|webgpu|fp16',
          model: 'model-b',
        },
        event: 'hit',
        id: 'embed-2',
        type: 'diagnostic',
        workerInstanceId: 'worker-a',
      })
    ).toThrow('Embedding telemetry cache hit must reference tracked resident cache state.');
    expect(() =>
      recordEmbeddingPipelineCacheTelemetry('worker-a', {
        cacheSize: 2,
        diagnostic: 'pipeline-cache',
        emittedAt: 300,
        entry: residentEntry,
        event: 'hit',
        id: 'embed-2',
        type: 'diagnostic',
        workerInstanceId: 'worker-a',
      })
    ).toThrow('Embedding telemetry cache hit must reference tracked resident cache state.');
    expect(() =>
      recordEmbeddingPipelineCacheTelemetry('worker-a', {
        cacheSize: 1,
        diagnostic: 'pipeline-cache',
        emittedAt: 300,
        entry: {
          ...residentEntry,
          memory: {
            ...residentEntry.memory,
            gpuBytes: 2048,
          },
        },
        event: 'hit',
        id: 'embed-2',
        type: 'diagnostic',
        workerInstanceId: 'worker-a',
      })
    ).toThrow('Embedding telemetry cache hit must preserve immutable resident cache identity.');
    expect(() =>
      recordEmbeddingPipelineCacheTelemetry('worker-a', {
        cacheSize: 1,
        diagnostic: 'pipeline-cache',
        emittedAt: 300,
        entry: {
          ...residentEntry,
          lastUsedAt: residentEntry.lastUsedAt - 1,
        },
        event: 'hit',
        id: 'embed-2',
        type: 'diagnostic',
        workerInstanceId: 'worker-a',
      })
    ).toThrow('Embedding telemetry cache hit timestamps must be monotonic.');
    expect(() =>
      recordEmbeddingPipelineCacheTelemetry('worker-a', {
        cacheSize: 1,
        diagnostic: 'pipeline-cache',
        emittedAt: 300,
        entry: {
          ...residentEntry,
          residencyMs: residentEntry.residencyMs - 1,
        },
        event: 'hit',
        id: 'embed-2',
        type: 'diagnostic',
        workerInstanceId: 'worker-a',
      })
    ).toThrow('Embedding telemetry cache hit timestamps must be monotonic.');
    expect(getEmbeddingTelemetrySnapshot().cache.entries).toEqual([
      expect.objectContaining({ cacheKey: residentEntry.cacheKey, sourceId: 'worker-a' }),
    ]);
  });
});
