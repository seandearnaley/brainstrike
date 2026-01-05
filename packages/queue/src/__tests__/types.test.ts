import { describe, expect, it } from 'vitest';
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
} from '../types';
import { toWorkerRequest } from '../types';

const basePayload = {
  kind: 'embed' as const,
  deviceHint: 'wasm' as const,
};

const baseRequest = {
  type: 'embed' as const,
  deviceHint: 'wasm' as const,
};

describe('toWorkerRequest', () => {
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
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      dtype: 'fp32',
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      dtype: 'fp32',
    });
  });

  it('should include deviceHint', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      deviceHint: 'webgpu',
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });
  });

  it('should include maxBatchSize when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      maxBatchSize: 32,
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      maxBatchSize: 32,
    });
  });

  it('should include provider when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      provider: 'openai',
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      provider: 'openai',
    });
  });

  it('should include targetDimension when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      targetDimension: 768,
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      targetDimension: 768,
    });
  });

  it('should include dimensionParameter when provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      dimensionParameter: 'dimensions',
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-123',
      model: 'test-model',
      texts: ['hello'],
      dimensionParameter: 'dimensions',
    });
  });

  it('should include all optional fields when all are provided', () => {
    const payload: EmbedTaskPayload = {
      ...basePayload,
      id: 'task-456',
      model: 'bert-base',
      texts: ['first', 'second', 'third'],
      truncateDim: 384,
      dtype: 'fp16',
      deviceHint: 'wasm',
      maxBatchSize: 16,
      provider: 'huggingface',
      targetDimension: 512,
      dimensionParameter: 'output_dimensionality',
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-456',
      model: 'bert-base',
      texts: ['first', 'second', 'third'],
      truncateDim: 384,
      dtype: 'fp16',
      deviceHint: 'wasm',
      maxBatchSize: 16,
      provider: 'huggingface',
      targetDimension: 512,
      dimensionParameter: 'output_dimensionality',
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
    expect(Object.keys(result)).toEqual(['type', 'id', 'model', 'texts', 'deviceHint']);
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
      model: 'test-model',
      texts: ['hello'],
      truncateDim: 0,
      maxBatchSize: 0,
      targetDimension: 0,
    };

    const result = toWorkerRequest(payload);

    expect(result).toEqual({
      ...baseRequest,
      id: 'task-zero',
      model: 'test-model',
      texts: ['hello'],
      truncateDim: 0,
      maxBatchSize: 0,
      targetDimension: 0,
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
        id: `task-${param}`,
        model: 'test-model',
        texts: ['hello'],
        dimensionParameter: param,
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
        type: 'initialization_timeout',
        message: 'Worker failed to initialize within timeout',
      };
      expect(error.type).toBe('initialization_timeout');
      expect(error.message).toBeDefined();
      expect(error.cause).toBeUndefined();
    });

    it('should allow optional cause', () => {
      const cause = new Error('Original error');
      const error: WorkerClientError = {
        type: 'worker_error',
        message: 'Worker crashed',
        cause,
      };
      expect(error.cause).toBe(cause);
    });
  });

  describe('WorkerClient', () => {
    it('should define required lifecycle methods', () => {
      const client: WorkerClient = {
        isReady: () => true,
        getState: () => 'ready',
        terminate: () => {},
      };

      expect(client.isReady()).toBe(true);
      expect(client.getState()).toBe('ready');
      expect(() => client.terminate()).not.toThrow();
    });

    it('should support state transitions', () => {
      let state: WorkerClientState = 'initializing';
      const client: WorkerClient = {
        isReady: () => state === 'ready',
        getState: () => state,
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
        isReady: () => true,
        getState: () => 'ready',
        terminate: () => {},
        waitForReady: async () => true,
      };

      expect(client.isReady()).toBe(true);
      expect(typeof client.waitForReady).toBe('function');
    });

    it('should allow optional timeout parameter', async () => {
      const client: WorkerClientWithTimeout = {
        isReady: () => true,
        getState: () => 'ready',
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
        queued: 10,
        running: 2,
        failed: 1,
        succeeded: 100,
        nextRunnableAt: '2025-01-04T12:00:00Z',
      };
      expect(stats.queued).toBe(10);
      expect(stats.running).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.succeeded).toBe(100);
      expect(stats.nextRunnableAt).toBe('2025-01-04T12:00:00Z');
    });

    it('should allow null nextRunnableAt', () => {
      const stats: DurableQueueStats = {
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 50,
        nextRunnableAt: null,
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
        totalEnqueued: 55,
        lastError: 'Model download failed',
        throughputPerMinute: 12.5,
        latencyAvgMs: 250,
        latencyP50Ms: 200,
        latencyP95Ms: 500,
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
        totalEnqueued: 0,
        lastError: null,
        throughputPerMinute: 0,
        latencyAvgMs: null,
        latencyP50Ms: null,
        latencyP95Ms: null,
        windowErrorCount: 0,
      };
      expect(metrics.latencyAvgMs).toBeNull();
      expect(metrics.lastError).toBeNull();
    });
  });

  describe('WorkerHealthStatus', () => {
    it('should represent healthy worker state', () => {
      const health: WorkerHealthStatus = {
        state: 'ready',
        isReady: true,
        error: null,
      };
      expect(health.state).toBe('ready');
      expect(health.isReady).toBe(true);
      expect(health.error).toBeNull();
    });

    it('should represent error state with details', () => {
      const health: WorkerHealthStatus = {
        state: 'error',
        isReady: false,
        error: {
          type: 'initialization_timeout',
          message: 'Worker failed to initialize within 30s',
        },
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
          queued: 5,
          running: 1,
          failed: 0,
          succeeded: 200,
          nextRunnableAt: null,
        },
        ephemeralQueue: {
          active: 1,
          completed: 20,
          failed: 0,
          totalEnqueued: 21,
          lastError: null,
          throughputPerMinute: 8.0,
          latencyAvgMs: 180,
          latencyP50Ms: 150,
          latencyP95Ms: 350,
          windowErrorCount: 0,
        },
        workerHealth: {
          state: 'ready',
          isReady: true,
          error: null,
        },
        lastUpdated: now,
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
        workerHealth: null, // No worker client
        lastUpdated: Date.now(),
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
          totalEnqueued: 13,
          lastError: 'Rate limited',
          throughputPerMinute: 5.0,
          latencyAvgMs: 300,
          latencyP50Ms: 250,
          latencyP95Ms: 600,
          windowErrorCount: 1,
        },
        workerHealth: {
          state: 'ready',
          isReady: true,
          error: null,
        },
        lastUpdated: Date.now(),
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
        workerHealth: null,
        lastUpdated: Date.now(),
      };

      listener(health);
      expect(receivedMetrics).toHaveLength(1);
      expect(receivedMetrics[0]).toBe(health);
    });
  });
});
