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
});
