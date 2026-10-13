import { describe, expect, expectTypeOf, it } from 'vitest';
import type { WorkerpoolAdapterOptions } from '../browser-workerpool-options.js';
import type {
  DurableQueueStats,
  EmbedTaskPayload,
  EphemeralQueueMetrics,
  QueueHealthListener,
  QueueHealthMetrics,
  WorkerClient,
  WorkerClientError,
  WorkerClientErrorType,
  WorkerClientState,
  WorkerClientWithTimeout,
  WorkerHealthStatus,
} from '../types.js';
import { toWorkerRequest } from '../types.js';

const basePayload = {
  deviceHint: 'wasm' as const,
  kind: 'embed' as const,
};

const baseRequest = {
  deviceHint: 'wasm' as const,
  type: 'embed' as const,
};

describe('WorkerpoolAdapterOptions', () => {
  it('requires the runtime telemetry sink in its public type', () => {
    type TelemetryIsRequired =
      Record<never, never> extends Pick<WorkerpoolAdapterOptions, 'telemetry'> ? false : true;

    expectTypeOf<TelemetryIsRequired>().toEqualTypeOf<true>();
  });
});

describe('toWorkerRequest', () => {
  it('preserves an explicit immutable revision in the scalar worker request', () => {
    const revision = '751bff37182d3f1213fa05d7196b954e230abad9';
    expect(
      toWorkerRequest({
        ...basePayload,
        id: 'pinned',
        model: 'Xenova/all-MiniLM-L6-v2',
        revision,
        texts: ['query'],
      })
    ).toMatchObject({ revision });
  });
  it.each(['mean', 'cls'] as const)(
    'preserves the model pooling %s in the scalar worker request (BST-1993)',
    (pooling) => {
      expect(
        toWorkerRequest({
          ...basePayload,
          id: 'pooled',
          model: 'onnx-community/granite-embedding-small-english-r2-ONNX',
          pooling,
          texts: ['query'],
        })
      ).toMatchObject({ pooling });
    }
  );
  it('rejects an empty revision rather than dropping the pin', () => {
    expect(() =>
      toWorkerRequest({
        ...basePayload,
        id: 'pinned',
        model: 'Xenova/all-MiniLM-L6-v2',
        revision: '',
        texts: ['query'],
      })
    ).toThrow('revision');
  });

  it('should convert minimal EmbedTaskPayload to EmbedWorkerRequest', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello', 'world'],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello', 'world'],
    });
  });

  it('should include truncateDim when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      truncateDim: 512,
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      truncateDim: 512,
    });
  });

  it('should include dtype when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      dtype: 'fp32',
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      dtype: 'fp32',
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
    });
  });

  it('should include deviceHint', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      deviceHint: 'webgpu',
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      deviceHint: 'webgpu',
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
    });
  });

  it('should include maxBatchSize when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      maxBatchSize: 32,
      model: 'test-model',
      texts: ['hello'],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      maxBatchSize: 32,
      model: 'test-model',
      texts: ['hello'],
    });
  });

  it('should include provider when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      provider: 'openai',
      texts: ['hello'],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      provider: 'openai',
      texts: ['hello'],
    });
  });

  it('should include targetDimension when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      targetDimension: 768,
      texts: ['hello'],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      targetDimension: 768,
      texts: ['hello'],
    });
  });

  it('should include dimensionParameter when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      dimensionParameter: 'dimensions',
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      dimensionParameter: 'dimensions',
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
    });
  });

  it('should include all optional fields when all are provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      deviceHint: 'wasm',
      dimensionParameter: 'output_dimensionality',
      dtype: 'fp16',
      id: 'task-456',
      maxBatchSize: 16,
      model: 'bert-base',
      provider: 'huggingface',
      targetDimension: 512,
      texts: ['first', 'second', 'third'],
      truncateDim: 384,
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      deviceHint: 'wasm',
      dimensionParameter: 'output_dimensionality',
      dtype: 'fp16',
      id: 'task-456',
      maxBatchSize: 16,
      model: 'bert-base',
      provider: 'huggingface',
      targetDimension: 512,
      texts: ['first', 'second', 'third'],
      truncateDim: 384,
    });
  });

  it('should not include optional fields when they are not provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-789',
      model: 'test-model',
      texts: ['text'],
    };

    const result = toWorkerRequest(payload);

    // Should only have required fields
    expect(result).toEqual({
      ...baseRequest,
      id: 'task-789',
      model: 'test-model',
      texts: ['text'],
    });

    // Verify no extra keys are present
    expect(Object.keys(result)).toEqual(['id', 'model', 'texts', 'type', 'deviceHint']);
  });

  it('should handle empty texts array', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-empty',
      model: 'test-model',
      texts: [],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-empty',
      model: 'test-model',
      texts: [],
    });
  });

  it('should handle single text in array', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-single',
      model: 'test-model',
      texts: ['single text'],
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-single',
      model: 'test-model',
      texts: ['single text'],
    });
  });

  it('should handle large texts array', () => {
    const texts = Array.from({ length: 1000 }, (_, index) => `text-${index}`);
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-large',
      model: 'test-model',
      texts,
    };

    const result = toWorkerRequest(payload);

    expect(result.texts).toHaveLength(1000);
    expect(result.texts[0]).toBe('text-0');
    expect(result.texts[999]).toBe('text-999');
  });

  it('should handle zero values for numeric fields', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-zero',
      maxBatchSize: 0,
      model: 'test-model',
      targetDimension: 0,
      texts: ['hello'],
      truncateDim: 0,
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-zero',
      maxBatchSize: 0,
      model: 'test-model',
      targetDimension: 0,
      texts: ['hello'],
      truncateDim: 0,
    });
  });

  it('should preserve readonly array characteristics', () => {
    const texts = ['immutable', 'texts'] as const;
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-readonly',
      model: 'test-model',
      texts,
    };

    const result = toWorkerRequest(payload);

    expect(result.texts).toEqual(['immutable', 'texts']);
  });

  it('should handle different dimensionParameter values', () => {
    const parameters: Array<'dimensions' | 'output_dimensionality' | 'output_dimension'> = [
      'dimensions',
      'output_dimensionality',
      'output_dimension',
    ];

    for (const param of parameters) {
      const payload: EmbedTaskPayload = {
        ...basePayload,
        dimensionParameter: param,
        id: `task-${param}`,
        model: 'test-model',
        texts: ['hello'],
      };

      const result = toWorkerRequest(payload);

      expect(result.dimensionParameter).toBe(param);
    }
  });
});

describe('WorkerClient types (BST-165)', () => {
  describe('WorkerClientState', () => {
    it('should accept valid state values', () => {
      const states: WorkerClientState[] = ['initializing', 'ready', 'terminated', 'error'];
      expect(states).toHaveLength(4);
    });
  });

  describe('WorkerClientErrorType', () => {
    it('should accept valid error type values', () => {
      const errorTypes: WorkerClientErrorType[] = [
        'initialization_timeout',
        'worker_error',
        'message_timeout',
        'terminated',
      ];
      expect(errorTypes).toHaveLength(4);
    });
  });

  describe('WorkerClientError', () => {
    it('should create valid error objects', () => {
      const error: WorkerClientError = {
        message: 'Worker failed to initialize within timeout',
        type: 'initialization_timeout',
      };
      expect(error.type).toBe('initialization_timeout');
      expect(error.message).toBeDefined();
      expect(error.cause).toBeUndefined();
    });

    it('should allow optional cause', () => {
      const cause = new Error('Original error');
      const error: WorkerClientError = {
        cause,
        message: 'Worker crashed',
        type: 'worker_error',
      };
      expect(error.cause).toBe(cause);
    });
  });

  describe('WorkerClient', () => {
    it('should define required lifecycle methods', () => {
      const client: WorkerClient = {
        getState: () => 'ready',
        isReady: () => true,
        terminate: () => {},
      };

      expect(client.isReady()).toBe(true);
      expect(client.getState()).toBe('ready');
      expect(() => client.terminate()).not.toThrow();
    });

    it('should support state transitions', () => {
      let state: WorkerClientState = 'initializing';
      const client: WorkerClient = {
        getState: () => state,
        isReady: () => state === 'ready',
        terminate: () => {
          state = 'terminated';
        },
      };

      expect(client.isReady()).toBe(false);
      expect(client.getState()).toBe('initializing');

      state = 'ready';
      expect(client.isReady()).toBe(true);

      client.terminate();
      expect(client.getState()).toBe('terminated');
    });
  });

  describe('WorkerClientWithTimeout', () => {
    it('should extend WorkerClient with waitForReady', () => {
      const client: WorkerClientWithTimeout = {
        getState: () => 'ready',
        isReady: () => true,
        terminate: () => {},
        waitForReady: async () => true,
      };

      expect(client.isReady()).toBe(true);
      expect(typeof client.waitForReady).toBe('function');
    });

    it('should allow optional timeout parameter', async () => {
      const client: WorkerClientWithTimeout = {
        getState: () => 'ready',
        isReady: () => true,
        terminate: () => {},
        waitForReady: async (_timeout?: number) => true,
      };

      // Call without timeout
      const result1 = await client.waitForReady();
      expect(result1).toBe(true);

      // Call with timeout
      const result2 = await client.waitForReady(5000);
      expect(result2).toBe(true);
    });
  });
});

describe('Queue Health Diagnostics types (BST-166)', () => {
  describe('DurableQueueStats', () => {
    it('should represent durable queue state counts', () => {
      const stats: DurableQueueStats = {
        failed: 1,
        nextRunnableAt: '2025-01-04T12:00:00Z',
        queued: 10,
        running: 2,
        succeeded: 100,
      };
      expect(stats.queued).toBe(10);
      expect(stats.running).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.succeeded).toBe(100);
      expect(stats.nextRunnableAt).toBe('2025-01-04T12:00:00Z');
    });

    it('should allow null nextRunnableAt', () => {
      const stats: DurableQueueStats = {
        failed: 0,
        nextRunnableAt: null,
        queued: 0,
        running: 0,
        succeeded: 50,
      };
      expect(stats.nextRunnableAt).toBeNull();
    });
  });

  describe('EphemeralQueueMetrics', () => {
    it('should represent runtime telemetry metrics', () => {
      const metrics: EphemeralQueueMetrics = {
        active: 3,
        completed: 50,
        failed: 2,
        lastError: 'Model download failed',
        latencyAvgMs: 250,
        latencyP50Ms: 200,
        latencyP95Ms: 500,
        throughputPerMinute: 12.5,
        totalEnqueued: 55,
        windowErrorCount: 1,
      };
      expect(metrics.active).toBe(3);
      expect(metrics.throughputPerMinute).toBe(12.5);
      expect(metrics.latencyP95Ms).toBe(500);
    });

    it('should allow null latency values when no data', () => {
      const metrics: EphemeralQueueMetrics = {
        active: 0,
        completed: 0,
        failed: 0,
        lastError: null,
        latencyAvgMs: null,
        latencyP50Ms: null,
        latencyP95Ms: null,
        throughputPerMinute: 0,
        totalEnqueued: 0,
        windowErrorCount: 0,
      };
      expect(metrics.latencyAvgMs).toBeNull();
      expect(metrics.lastError).toBeNull();
    });
  });

  describe('WorkerHealthStatus', () => {
    it('should represent healthy worker state', () => {
      const health: WorkerHealthStatus = {
        error: null,
        isReady: true,
        state: 'ready',
      };
      expect(health.state).toBe('ready');
      expect(health.isReady).toBe(true);
      expect(health.error).toBeNull();
    });

    it('should represent error state with details', () => {
      const health: WorkerHealthStatus = {
        error: {
          message: 'Worker failed to initialize within 30s',
          type: 'initialization_timeout',
        },
        isReady: false,
        state: 'error',
      };
      expect(health.state).toBe('error');
      expect(health.isReady).toBe(false);
      expect(health.error?.type).toBe('initialization_timeout');
    });
  });

  describe('QueueHealthMetrics', () => {
    it('should consolidate all health data', () => {
      const now = Date.now();
      const health: QueueHealthMetrics = {
        durableQueue: {
          failed: 0,
          nextRunnableAt: null,
          queued: 5,
          running: 1,
          succeeded: 200,
        },
        ephemeralQueue: {
          active: 1,
          completed: 20,
          failed: 0,
          lastError: null,
          latencyAvgMs: 180,
          latencyP50Ms: 150,
          latencyP95Ms: 350,
          throughputPerMinute: 8.0,
          totalEnqueued: 21,
          windowErrorCount: 0,
        },
        lastUpdated: now,
        workerHealth: {
          error: null,
          isReady: true,
          state: 'ready',
        },
      };

      expect(health.durableQueue?.queued).toBe(5);
      expect(health.ephemeralQueue?.throughputPerMinute).toBe(8.0);
      expect(health.workerHealth?.isReady).toBe(true);
      expect(health.lastUpdated).toBe(now);
    });

    it('should allow null for unavailable sources', () => {
      const health: QueueHealthMetrics = {
        durableQueue: null, // DB not connected
        ephemeralQueue: null, // Workerpool not initialized
        lastUpdated: Date.now(),
        workerHealth: null, // No worker client
      };

      expect(health.durableQueue).toBeNull();
      expect(health.ephemeralQueue).toBeNull();
      expect(health.workerHealth).toBeNull();
    });

    it('should support partial availability', () => {
      // Only ephemeral queue available (no DB)
      const health: QueueHealthMetrics = {
        durableQueue: null,
        ephemeralQueue: {
          active: 2,
          completed: 10,
          failed: 1,
          lastError: 'Rate limited',
          latencyAvgMs: 300,
          latencyP50Ms: 250,
          latencyP95Ms: 600,
          throughputPerMinute: 5.0,
          totalEnqueued: 13,
          windowErrorCount: 1,
        },
        lastUpdated: Date.now(),
        workerHealth: {
          error: null,
          isReady: true,
          state: 'ready',
        },
      };

      expect(health.durableQueue).toBeNull();
      expect(health.ephemeralQueue?.active).toBe(2);
      expect(health.workerHealth?.state).toBe('ready');
    });
  });

  describe('QueueHealthListener', () => {
    it('should accept health metrics callback', () => {
      const receivedMetrics: QueueHealthMetrics[] = [];
      const listener: QueueHealthListener = (metrics) => {
        receivedMetrics.push(metrics);
      };

      const health: QueueHealthMetrics = {
        durableQueue: null,
        ephemeralQueue: null,
        lastUpdated: Date.now(),
        workerHealth: null,
      };

      listener(health);
      expect(receivedMetrics).toHaveLength(1);
      expect(receivedMetrics[0]).toBe(health);
    });
  });
});
