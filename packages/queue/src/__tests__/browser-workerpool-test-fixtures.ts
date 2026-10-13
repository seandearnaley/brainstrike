import type { QueueResult, TaskPayload } from '../types.js';

export function createTask(id: string): TaskPayload {
  return {
    deviceHint: 'webgpu',
    id,
    kind: 'embed',
    model: 'local:test',
    texts: ['hello'],
  };
}

export function createResult(id: string): QueueResult {
  return {
    id,
    metadata: {
      batchSize: 1,
      device: 'webgpu',
      dimensions: 3,
      dtype: 'fp16',
      elapsedMs: 10,
      fallbackApplied: false,
      model: 'local:test',
      pooling: 'mean',
    },
    type: 'result',
    vectors: [new Float32Array([1, 2, 3])],
  };
}

export function createPipelineCacheEntry(cacheKey = 'local:test|webgpu|fp16') {
  return {
    cacheKey,
    createdAt: 50,
    device: 'webgpu' as const,
    dtype: 'fp16' as const,
    lastUsedAt: 100,
    memory: { gpuBytes: 1024, heapBytes: 0, reason: 'model-size-estimate' as const },
    model: 'local:test',
    residencyMs: 50,
  };
}

export function createPipelineCacheDiagnostic(
  id: string,
  workerInstanceId: string,
  entry = createPipelineCacheEntry()
) {
  return {
    cacheSize: 1,
    diagnostic: 'pipeline-cache',
    emittedAt: 100,
    entries: [entry],
    entry,
    event: 'loaded',
    id,
    type: 'diagnostic',
    workerInstanceId,
  } as const;
}
