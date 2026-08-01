import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEmbeddingTelemetrySnapshot,
  recordEmbeddingBatchTelemetry,
  recordEmbeddingPipelineCacheTelemetry,
  removeEmbeddingTelemetrySource,
  resetEmbeddingTelemetryForTests,
  subscribeEmbeddingTelemetry,
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
