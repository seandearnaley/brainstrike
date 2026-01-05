import { describe, expect, it } from 'vitest';
import type {
  EmbedTaskPayload,
  WorkerClient,
  WorkerClientError,
  WorkerClientErrorType,
  WorkerClientState,
  WorkerClientWithTimeout,
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
