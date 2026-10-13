import { describe, expect, it } from 'vitest';
import {
  assertEmbedWorkerBatch,
  assertEmbedWorkerComplete,
  assertEmbedWorkerLifetimeError,
  assertEmbedWorkerPipelineCacheDiagnostic,
  assertEmbedWorkerPipelineCacheMemoryDiagnostic,
  assertEmbedWorkerTelemetrySourceClosed,
} from '../embedding-worker-protocol.js';

const MEMORY_PATH = 'test.memory';

function makeMemory(
  overrides: Partial<{
    gpuBytes: number | null;
    heapBytes: number | null;
    reason: string;
  }> = {}
): Record<string, unknown> {
  return {
    gpuBytes: 2048,
    heapBytes: null,
    reason: 'measured',
    ...overrides,
  };
}

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cacheKey: 'entry-key',
    createdAt: 1,
    device: 'webgpu',
    dtype: 'fp16',
    lastUsedAt: 2,
    memory: makeMemory({ gpuBytes: 2048 }),
    model: 'text-embedding-3-small',
    residencyMs: 3,
    ...overrides,
  };
}

function makeCacheDiagnostic(overrides: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    cacheSize: 1,
    diagnostic: 'pipeline-cache',
    emittedAt: 10,
    entry: makeEntry(),
    type: 'diagnostic',
    workerInstanceId: 'worker-1',
    ...overrides,
  };
  return base;
}

describe('assertEmbedWorkerTelemetrySourceClosed', () => {
  it('accepts a well-formed device-lost close event', () => {
    expect(() =>
      assertEmbedWorkerTelemetrySourceClosed({
        reason: 'device-lost',
        type: 'telemetry-source-closed',
        workerInstanceId: 'worker-1',
      })
    ).not.toThrow();
  });

  it('rejects non-object payloads', () => {
    expect(() => assertEmbedWorkerTelemetrySourceClosed(null)).toThrow('must be an object');
    expect(() => assertEmbedWorkerTelemetrySourceClosed(['telemetry-source-closed'])).toThrow(
      'must be an object'
    );
    expect(() => assertEmbedWorkerTelemetrySourceClosed('closed')).toThrow('must be an object');
  });

  it('rejects a wrong event type and a wrong close reason', () => {
    expect(() =>
      assertEmbedWorkerTelemetrySourceClosed({
        reason: 'device-lost',
        type: 'progress',
        workerInstanceId: 'worker-1',
      })
    ).toThrow('invalid type');
    expect(() =>
      assertEmbedWorkerTelemetrySourceClosed({
        reason: 'idle-timeout',
        type: 'telemetry-source-closed',
        workerInstanceId: 'worker-1',
      })
    ).toThrow('invalid reason');
  });

  it('requires a non-empty worker instance identity', () => {
    expect(() =>
      assertEmbedWorkerTelemetrySourceClosed({
        reason: 'device-lost',
        type: 'telemetry-source-closed',
        workerInstanceId: '',
      })
    ).toThrow('requires a worker instance identity');
  });
});

describe('assertEmbedWorkerLifetimeError', () => {
  it('rejects payloads that are not objects', () => {
    expect(() => assertEmbedWorkerLifetimeError(undefined)).toThrow('must be an object');
    expect(() => assertEmbedWorkerLifetimeError(7)).toThrow('must be an object');
  });

  it('rejects a wrong type and a blank message', () => {
    expect(() =>
      assertEmbedWorkerLifetimeError({
        message: 'm',
        type: 'error',
        workerInstanceId: 'worker-1',
      })
    ).toThrow('invalid type');
    expect(() =>
      assertEmbedWorkerLifetimeError({
        message: '',
        type: 'worker-lifetime-error',
        workerInstanceId: 'worker-1',
      })
    ).toThrow('requires a message');
  });

  it('accepts the explicit device-loss discriminator and refuses unknown codes', () => {
    const event = {
      cause: 'destroyed: device1',
      message: 'WebGPU device was lost. Choose the model again to retry.',
      type: 'worker-lifetime-error',
      workerInstanceId: 'worker-device-loss',
    };
    expect(() =>
      assertEmbedWorkerLifetimeError({ ...event, code: 'EMBEDDING_DEVICE_LOST' })
    ).not.toThrow();
    expect(() => assertEmbedWorkerLifetimeError({ ...event, code: 'unrecognized' })).toThrow(
      'invalid code'
    );
  });

  it('rejects a non-string optional cause and a missing worker identity', () => {
    expect(() =>
      assertEmbedWorkerLifetimeError({
        cause: 42,
        message: 'm',
        type: 'worker-lifetime-error',
        workerInstanceId: 'worker-1',
      })
    ).toThrow('cause must be a string');
    expect(() =>
      assertEmbedWorkerLifetimeError({
        message: 'm',
        type: 'worker-lifetime-error',
        workerInstanceId: '',
      })
    ).toThrow('requires a worker instance identity');
  });
});

describe('assertEmbedWorkerPipelineCacheMemoryDiagnostic', () => {
  it('accepts every supported measurement reason on both devices', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(makeMemory(), 'webgpu', MEMORY_PATH)
    ).not.toThrow();
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: null, heapBytes: 4096 }),
        'wasm',
        MEMORY_PATH
      )
    ).not.toThrow();
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: null, heapBytes: null, reason: 'browser-runtime-unavailable' }),
        'webgpu',
        MEMORY_PATH
      )
    ).not.toThrow();
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: 900_000, heapBytes: 0, reason: 'model-size-estimate' }),
        'webgpu',
        MEMORY_PATH
      )
    ).not.toThrow();
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: 0, heapBytes: 120_000, reason: 'model-size-estimate' }),
        'wasm',
        MEMORY_PATH
      )
    ).not.toThrow();
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: null, heapBytes: null, reason: 'model-size-unknown' }),
        'wasm',
        MEMORY_PATH
      )
    ).not.toThrow();
  });

  it('rejects non-object payloads and malformed byte counts', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic('measured', 'webgpu', MEMORY_PATH)
    ).toThrow('must be an object');
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: -1 }),
        'webgpu',
        MEMORY_PATH
      )
    ).toThrow(`${MEMORY_PATH}.gpuBytes`);
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ heapBytes: Number.NaN }),
        'wasm',
        MEMORY_PATH
      )
    ).toThrow(`${MEMORY_PATH}.heapBytes`);
  });

  it('rejects an unrecognized reason', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ reason: 'vibes' }),
        'webgpu',
        MEMORY_PATH
      )
    ).toThrow('reason is invalid');
  });

  it('forbids bytes for reasons that cannot measure and demands them for reasons that can', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: 12, reason: 'browser-runtime-unavailable' }),
        'webgpu',
        MEMORY_PATH
      )
    ).toThrow('must not report bytes');
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: null, heapBytes: null }),
        'webgpu',
        MEMORY_PATH
      )
    ).toThrow(/must report bytes/);
  });

  it('keeps wasm diagnostics free of GPU byte attributions', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: 64 }),
        'wasm',
        MEMORY_PATH
      )
    ).toThrow('must be null or zero for wasm');
  });

  it('enforces device-correct attribution for model-size estimates', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: 100, heapBytes: 5, reason: 'model-size-estimate' }),
        'webgpu',
        MEMORY_PATH
      )
    ).toThrow('attribute a WebGPU model-size estimate to GPU bytes');
    expect(() =>
      assertEmbedWorkerPipelineCacheMemoryDiagnostic(
        makeMemory({ gpuBytes: 0, heapBytes: 0, reason: 'model-size-estimate' }),
        'wasm',
        MEMORY_PATH
      )
    ).toThrow('attribute a WASM model-size estimate to heap bytes');
  });
});

describe('assertEmbedWorkerBatch', () => {
  function makeBatch(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      batchIndex: 0,
      endIndex: 2,
      id: 'batch-1',
      peakVectorsInFlight: 3,
      startIndex: 0,
      transferBytes: 24,
      type: 'batch',
      vectors: [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])],
      vectorsInFlight: 2,
      ...overrides,
    };
  }

  it('accepts a coherent batch whose transfer bytes match unique buffers', () => {
    const sharedBuffer = new Float32Array([7, 8, 9]).buffer;
    const first = new Float32Array(sharedBuffer, 0, 3);
    const second = new Float32Array(sharedBuffer, 0, 3);
    // Two distinct views over ONE buffer count once toward transferBytes.
    expect(() =>
      assertEmbedWorkerBatch(
        makeBatch({
          peakVectorsInFlight: 4,
          transferBytes: sharedBuffer.byteLength,
          vectors: [first, second],
        })
      )
    ).not.toThrow();
  });

  it('rejects structural violations before inspecting vectors', () => {
    expect(() => assertEmbedWorkerBatch(null)).toThrow('must be an object');
    expect(() => assertEmbedWorkerBatch(makeBatch({ type: 'result' }))).toThrow(
      'batch.type must be "batch"'
    );
    expect(() => assertEmbedWorkerBatch(makeBatch({ id: '' }))).toThrow(
      'batch.id must be a non-empty string'
    );
    expect(() => assertEmbedWorkerBatch(makeBatch({ batchIndex: -1 }))).toThrow('batch.batchIndex');
    expect(() => assertEmbedWorkerBatch(makeBatch({ endIndex: 1.5 }))).toThrow('batch.endIndex');
    expect(() => assertEmbedWorkerBatch(makeBatch({ endIndex: 2, startIndex: 2 }))).toThrow(
      'endIndex must be greater than startIndex'
    );
    expect(() => assertEmbedWorkerBatch(makeBatch({ vectors: 'nope' }))).toThrow(
      'batch.vectors must be an array'
    );
  });

  it('requires one finite Float32Array vector per index-range slot with a consistent shape', () => {
    expect(() => assertEmbedWorkerBatch(makeBatch({ vectors: [] }))).toThrow(
      'vector count must match its index range'
    );
    expect(() => assertEmbedWorkerBatch(makeBatch({ endIndex: 2, vectors: [[1], [2]] }))).toThrow(
      'must be a Float32Array'
    );
    expect(() =>
      assertEmbedWorkerBatch(makeBatch({ endIndex: 1, vectors: [new Float32Array(0)] }))
    ).toThrow('must not be empty');
    expect(() =>
      assertEmbedWorkerBatch(
        makeBatch({ endIndex: 1, vectors: [new Float32Array([Number.POSITIVE_INFINITY])] })
      )
    ).toThrow('must be finite');
    expect(() =>
      assertEmbedWorkerBatch(
        makeBatch({ endIndex: 2, vectors: [new Float32Array(3), new Float32Array(4)] })
      )
    ).toThrow('consistent shape');
  });

  it('keeps flight counters and transfer accounting honest', () => {
    expect(() => assertEmbedWorkerBatch(makeBatch({ vectorsInFlight: 1 }))).toThrow(
      'vectorsInFlight must match its vector count'
    );
    expect(() => assertEmbedWorkerBatch(makeBatch({ peakVectorsInFlight: 1 }))).toThrow(
      'peakVectorsInFlight must be at least vectorsInFlight'
    );
    expect(() => assertEmbedWorkerBatch(makeBatch({ transferBytes: 99 }))).toThrow(
      'transferBytes must match its unique transferred buffers'
    );
  });
});

describe('assertEmbedWorkerComplete', () => {
  function makeComplete(metadataOverrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'job-1',
      metadata: {
        batchSize: 4,
        device: 'wasm',
        dimensions: 384,
        dtype: 'q4',
        elapsedMs: 12,
        fallbackApplied: false,
        model: 'sentence-transformers/all-MiniLM-L6-v2',
        pooling: 'mean',
        ...metadataOverrides,
      },
      type: 'complete',
    };
  }

  it('accepts a well-formed completion event', () => {
    expect(() => assertEmbedWorkerComplete(makeComplete())).not.toThrow();
  });

  it('accepts q8 WASM completion and residency diagnostics', () => {
    expect(() => assertEmbedWorkerComplete(makeComplete({ dtype: 'q8' }))).not.toThrow();
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({
          entry: makeEntry({
            device: 'wasm',
            dtype: 'q8',
            memory: makeMemory({ gpuBytes: 0, heapBytes: 2048 }),
          }),
          event: 'hit',
        })
      )
    ).not.toThrow();
  });

  it('rejects envelope violations', () => {
    expect(() => assertEmbedWorkerComplete([])).toThrow('must be an object');
    expect(() => assertEmbedWorkerComplete({ id: 'job-1', metadata: {}, type: 'result' })).toThrow(
      '.type must be "complete"'
    );
  });

  it('validates every metadata field', () => {
    expect(() => assertEmbedWorkerComplete(makeComplete({ revision: '' }))).toThrow(
      'metadata.revision must be a non-empty string'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ revision: 123 }))).toThrow(
      'metadata.revision must be a non-empty string'
    );
    expect(() => assertEmbedWorkerComplete({ id: '', metadata: {}, type: 'complete' })).toThrow(
      '.id must be a non-empty string'
    );
    expect(() =>
      assertEmbedWorkerComplete({ id: 'job-1', metadata: null, type: 'complete' })
    ).toThrow('metadata must be an object');
    expect(() => assertEmbedWorkerComplete(makeComplete({ model: '' }))).toThrow(
      'metadata.model must be a non-empty string'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ device: 'cuda' }))).toThrow(
      'metadata.device is invalid'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ dtype: 'int8' }))).toThrow(
      'metadata.dtype is invalid'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ pooling: undefined }))).toThrow(
      'metadata.pooling is invalid'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ pooling: 'max' }))).toThrow(
      'metadata.pooling is invalid'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ pooling: 'cls' }))).not.toThrow();
    expect(() => assertEmbedWorkerComplete(makeComplete({ batchSize: -1 }))).toThrow(
      'metadata.batchSize must be a non-negative safe integer'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ elapsedMs: Number.NaN }))).toThrow(
      'metadata.elapsedMs must be a non-negative finite number'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ fallbackApplied: 'no' }))).toThrow(
      'metadata.fallbackApplied must be a boolean'
    );
    expect(() => assertEmbedWorkerComplete(makeComplete({ dimensions: 0 }))).toThrow(
      'metadata.dimensions must be a positive safe integer'
    );
  });
});

describe('assertEmbedWorkerPipelineCacheDiagnostic', () => {
  it('accepts a hit with a subject entry, positive cache size, and no reason', () => {
    const value = makeCacheDiagnostic({ event: 'hit' });
    expect(() => assertEmbedWorkerPipelineCacheDiagnostic(value)).not.toThrow();
  });

  it('accepts a loaded event carrying a full unique snapshot containing the subject', () => {
    const entry = makeEntry();
    const value = makeCacheDiagnostic({
      cacheSize: 2,
      entries: [makeEntry({ cacheKey: 'other' }), entry],
      event: 'loaded',
    });
    expect(() => assertEmbedWorkerPipelineCacheDiagnostic(value)).not.toThrow();
  });

  it('accepts disposal, eviction, invalidation, and load-failure events with their required reasons', () => {
    const removed = makeCacheDiagnostic({
      entries: [makeEntry({ cacheKey: 'other' })],
      event: 'disposed',
      reason: 'manual-dispose',
    });
    expect(() => assertEmbedWorkerPipelineCacheDiagnostic(removed)).not.toThrow();

    for (const reason of ['device-lost', 'idle-timeout', 'resident-limit']) {
      const evicted = makeCacheDiagnostic({
        entries: [makeEntry({ cacheKey: 'other' })],
        event: 'evicted',
        reason,
      });
      expect(() => assertEmbedWorkerPipelineCacheDiagnostic(evicted)).not.toThrow();
    }

    const invalidated = makeCacheDiagnostic({
      entries: [makeEntry()],
      event: 'invalidated',
      reason: 'device-lost',
    });
    expect(() => assertEmbedWorkerPipelineCacheDiagnostic(invalidated)).not.toThrow();

    const loadFailed = makeCacheDiagnostic({
      entries: [makeEntry()],
      event: 'load-failed',
      reason: 'load-failure',
    });
    expect(() => assertEmbedWorkerPipelineCacheDiagnostic(loadFailed)).not.toThrow();
  });

  it('rejects envelope violations up front', () => {
    expect(() => assertEmbedWorkerPipelineCacheDiagnostic('hit')).toThrow('must be an object');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ diagnostic: 'queue-depth' }))
    ).toThrow('pipeline-cache');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ cacheSize: -2 }))
    ).toThrow('cacheSize');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ cacheSize: 1.5 }))
    ).toThrow('safe integer');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ emittedAt: 'soon' }))
    ).toThrow('emittedAt');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ workerInstanceId: '' }))
    ).toThrow('workerInstanceId');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ event: 'hit', id: '' }))
    ).toThrow('diagnostic.id must be a non-empty string');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ event: 'purged' }))
    ).toThrow('event is invalid');
  });

  it('propagates malformed entry and entries collections', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({ entry: makeEntry({ device: 'tpu' }) })
      )
    ).toThrow('device must be');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({ entries: { length: 1 }, event: 'loaded' })
      )
    ).toThrow('entries must be an array');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({ entries: ['nope'], event: 'loaded' })
      )
    ).toThrow('must be an object');
  });

  it('enforces hit-event invariants', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({ entry: undefined, event: 'hit' })
      )
    ).toThrow('hit requires an entry');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ cacheSize: 0, event: 'hit' }))
    ).toThrow('hit requires a positive cacheSize');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({ event: 'hit', reason: 'manual-dispose' })
      )
    ).toThrow('hit must not include a reason');
  });

  it('enforces loaded-event snapshot integrity', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(makeCacheDiagnostic({ event: 'loaded' }))
    ).toThrow('loaded requires a full entries snapshot');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({ cacheSize: 2, entries: [makeEntry()], event: 'loaded' })
      )
    ).toThrow('unique cache entries');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({
          cacheSize: 2,
          entries: [makeEntry(), makeEntry()],
          event: 'loaded',
        })
      )
    ).toThrow('unique cache entries');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({
          entries: [makeEntry()],
          event: 'loaded',
          reason: 'device-lost',
        })
      )
    ).toThrow('loaded must not include a reason');
  });

  it('enforces removal-event invariants', () => {
    // Subject + well-formed snapshot must exist before reason validation runs.
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({
          entries: [makeEntry({ cacheKey: 'survivor' })],
          event: 'disposed',
          reason: 'idle-timeout',
        })
      )
    ).toThrow('disposed requires reason "manual-dispose"');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({
          entries: [makeEntry({ cacheKey: 'survivor' })],
          event: 'evicted',
          reason: 'manual-dispose',
        })
      )
    ).toThrow('evicted reason is invalid');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({
          entries: [makeEntry()],
          event: 'disposed',
          reason: 'manual-dispose',
        })
      )
    ).toThrow('subject entry must be absent');
  });

  it('enforces snapshot-event reason contracts', () => {
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({
          entries: [makeEntry()],
          event: 'invalidated',
          reason: 'idle-timeout',
        })
      )
    ).toThrow('invalidated requires reason "device-lost"');
    expect(() =>
      assertEmbedWorkerPipelineCacheDiagnostic(
        makeCacheDiagnostic({ entries: [makeEntry()], event: 'load-failed', reason: 'device-lost' })
      )
    ).toThrow('load-failed requires reason "load-failure"');
  });
});
