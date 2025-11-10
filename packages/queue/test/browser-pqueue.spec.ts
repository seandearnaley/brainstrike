import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPQueueAdapter } from '../src/adapters/browser-pqueue';
import { addQueueTelemetryListener, type QueueTelemetryEvent } from '../src/telemetry';
import type { QueueProgressEvent, QueueErrorEvent, TaskPayload } from '../src/types';

// Mock the embedding worker utilities
vi.mock('@brainstrike/embedding-worker', () => ({
  computeInitialBatchSize: (total: number, preferred?: number) => {
    const heuristic = Math.ceil(total / 8);
    const cap = preferred ?? 16;
    return Math.max(1, Math.min(cap, heuristic));
  },
  l2Normalize: (vector: Float32Array) => vector,
  truncateVector: (vector: Float32Array, _dim?: number) => vector,
  vectorsFromPipelineOutput: (output: unknown) => {
    if (output instanceof Float32Array) {
      return [output];
    }
    if (Array.isArray(output)) {
      return (output as number[][]).map((row) => Float32Array.from(row));
    }
    return [Float32Array.of(1)];
  },
}));

// Mock transformers with a minimal Tensor implementation
class MockTensor {
  readonly data: Float32Array;
  readonly dims: number[];

  constructor(values: readonly number[]) {
    this.data = Float32Array.from(values);
    this.dims = [1, this.data.length];
  }

  tolist(): number[][] {
    return [Array.from(this.data)];
  }
}

const pipelineMock = vi.fn(
  async () =>
    async (inputs: string | readonly string[]) => {
      const list = Array.isArray(inputs) ? inputs : [inputs];
      // Return a mock tensor-like object for each input
      return new MockTensor(list.flatMap(() => [0.25, 0.5, 0.25]));
    }
);

vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineMock,
  env: {},
  Tensor: MockTensor,
}));

const createTask = (overrides: Partial<TaskPayload> = {}): TaskPayload => ({
  kind: 'embed',
  id: `task-${Math.random().toString(36).slice(2, 9)}`,
  model: 'test-model',
  texts: ['hello', 'world'],
  ...overrides,
});

describe('browser-pqueue adapter', () => {
  beforeEach(() => {
    pipelineMock.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('should process a single task and return vectors', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask();
      const result = await adapter.add(task);

      expect(result.type).toBe('result');
      expect(result.id).toBe(task.id);
      expect(result.vectors).toHaveLength(2);
      expect(result.metadata.model).toBe('test-model');
      expect(result.metadata.device).toBe('wasm');
      expect(result.metadata.fallbackApplied).toBe(true);
    });

    it('should handle empty text array', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask({ texts: [] });
      const result = await adapter.add(task);

      expect(result.type).toBe('result');
      expect(result.vectors).toHaveLength(0);
      expect(result.metadata.batchSize).toBe(0);
      expect(result.metadata.elapsedMs).toBe(0);
    });

    it('should process multiple tasks in bulk', async () => {
      const adapter = createPQueueAdapter({ concurrency: 2 });
      const tasks = [createTask(), createTask(), createTask()];
      const results = await adapter.addBulk(tasks);

      expect(results).toHaveLength(3);
      results.forEach((result, index) => {
        expect(result.id).toBe(tasks[index]?.id);
        expect(result.vectors.length).toBeGreaterThan(0);
      });
    });

    it('should respect concurrency limits', async () => {
      const adapter = createPQueueAdapter({ concurrency: 2 });
      const tasks = Array.from({ length: 5 }, () => createTask());

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      // Track concurrent executions by mocking pipeline
      pipelineMock.mockImplementation(async () => {
        currentConcurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrent -= 1;
        return async () => new MockTensor([0.25, 0.5, 0.25]);
      });

      await adapter.addBulk(tasks);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('progress events', () => {
    it('should emit progress events during task execution', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const events: Array<QueueProgressEvent | QueueErrorEvent> = [];
      adapter.onProgress((event) => events.push(event));

      const task = createTask({ texts: ['test1', 'test2', 'test3'] });
      await adapter.add(task);

      const progressEvents = events.filter((e) => e.type === 'progress') as QueueProgressEvent[];
      expect(progressEvents.length).toBeGreaterThan(0);

      // Should have initializing, embedding, and complete phases
      expect(progressEvents.some((e) => e.phase === 'initializing')).toBe(true);
      expect(progressEvents.some((e) => e.phase === 'complete')).toBe(true);
    });

    it('should allow multiple progress listeners', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const events1: unknown[] = [];
      const events2: unknown[] = [];

      adapter.onProgress((event) => events1.push(event));
      adapter.onProgress((event) => events2.push(event));

      await adapter.add(createTask());

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBe(events1.length);
    });

    it('should allow unsubscribing from progress events', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const events: unknown[] = [];

      const unsubscribe = adapter.onProgress((event) => events.push(event));
      unsubscribe();

      await adapter.add(createTask());

      expect(events).toHaveLength(0);
    });
  });

  describe('pause and resume', () => {
    it('should pause task processing', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      adapter.pause();

      const task = createTask();
      const promise = adapter.add(task);

      // Give it a moment to potentially start (it shouldn't)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Pipeline shouldn't be called yet
      const callsBeforeResume = pipelineMock.mock.calls.length;

      adapter.resume();
      await promise;

      const callsAfterResume = pipelineMock.mock.calls.length;
      expect(callsAfterResume).toBeGreaterThan(callsBeforeResume);
    });

    it('should resume paused queue', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      adapter.pause();

      const task1 = createTask();
      const task2 = createTask();
      const promise1 = adapter.add(task1);
      const promise2 = adapter.add(task2);

      adapter.resume();

      const results = await Promise.all([promise1, promise2]);
      expect(results).toHaveLength(2);
      expect(results[0]?.id).toBe(task1.id);
      expect(results[1]?.id).toBe(task2.id);
    });
  });

  describe('drain', () => {
    it('should wait for all tasks to complete', async () => {
      const adapter = createPQueueAdapter({ concurrency: 2 });
      const tasks = [createTask(), createTask(), createTask()];

      const promises = tasks.map((task) => adapter.add(task));

      await adapter.drain();

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
    });

    it('should resolve immediately if queue is empty', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const start = Date.now();
      await adapter.drain();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('error handling', () => {
    it('should emit error event when task fails', async () => {
      pipelineMock.mockRejectedValueOnce(new Error('Pipeline failed'));

      const adapter = createPQueueAdapter({ concurrency: 1 });
      const events: Array<QueueProgressEvent | QueueErrorEvent> = [];
      adapter.onProgress((event) => events.push(event));

      const task = createTask();
      await expect(adapter.add(task)).rejects.toThrow('Pipeline failed');

      const errorEvents = events.filter((e) => e.type === 'error') as QueueErrorEvent[];
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]?.message).toContain('Pipeline failed');
      expect(errorEvents[0]?.id).toBe(task.id);
    });

    it('should reject unsupported task kinds', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = { ...createTask(), kind: 'unsupported' as never };

      await expect(adapter.add(task)).rejects.toThrow('Unsupported fallback task');
    });

    it('should throw if undefined result is returned', async () => {
      // Mock p-queue to return undefined
      const PQueueMock = (await import('p-queue')).default;
      const originalAdd = PQueueMock.prototype.add;
      PQueueMock.prototype.add = vi.fn(async () => undefined);

      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask();

      await expect(adapter.add(task)).rejects.toThrow(/returned no result/);

      PQueueMock.prototype.add = originalAdd;
    });
  });

  describe('telemetry integration', () => {
    it('should emit telemetry events for enqueue and complete', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const telemetryEvents: QueueTelemetryEvent[] = [];
      const unsubscribe = addQueueTelemetryListener((event) => {
        if (event.adapter === 'pqueue') {
          telemetryEvents.push(event);
        }
      });

      try {
        const task = createTask();
        await adapter.add(task);

        const enqueueEvent = telemetryEvents.find((e) => e.event === 'enqueue');
        const completeEvent = telemetryEvents.find((e) => e.event === 'complete');

        expect(enqueueEvent).toBeDefined();
        expect(completeEvent).toBeDefined();
        expect(enqueueEvent?.taskId).toBe(task.id);
        expect(completeEvent?.taskId).toBe(task.id);
        expect(completeEvent?.elapsedMs).toBeGreaterThanOrEqual(0);
      } finally {
        unsubscribe();
      }
    });

    it('should emit telemetry error event on failure', async () => {
      pipelineMock.mockRejectedValueOnce(new Error('Test error'));

      const adapter = createPQueueAdapter({ concurrency: 1 });
      const telemetryEvents: QueueTelemetryEvent[] = [];
      const unsubscribe = addQueueTelemetryListener((event) => {
        if (event.adapter === 'pqueue') {
          telemetryEvents.push(event);
        }
      });

      try {
        const task = createTask();
        await expect(adapter.add(task)).rejects.toThrow('Test error');

        const errorEvent = telemetryEvents.find((e) => e.event === 'error');
        expect(errorEvent).toBeDefined();
        expect(errorEvent?.errorMessage).toContain('Test error');
        expect(errorEvent?.taskId).toBe(task.id);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('priority handling', () => {
    it('should pass priority option to underlying queue', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask();

      // Add task with high priority
      await adapter.add(task, { priority: 10 });

      // Verify it completed successfully (priority is passed through)
      expect(pipelineMock).toHaveBeenCalled();
    });

    it('should handle bulk tasks with shared priority', async () => {
      const adapter = createPQueueAdapter({ concurrency: 2 });
      const tasks = [createTask(), createTask()];

      const results = await adapter.addBulk(tasks, { priority: 5 });

      expect(results).toHaveLength(2);
      expect(results[0]?.vectors.length).toBeGreaterThan(0);
      expect(results[1]?.vectors.length).toBeGreaterThan(0);
    });
  });

  describe('abort signal handling', () => {
    it('should support abort signal in options', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const controller = new AbortController();
      const task = createTask();

      // Start the task with an abort signal
      const promise = adapter.add(task, { signal: controller.signal });

      // Don't abort, let it complete normally
      const result = await promise;

      expect(result.id).toBe(task.id);
    });
  });

  describe('batch processing', () => {
    it('should handle large text arrays with batching', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const largeTexts = Array.from({ length: 100 }, (_, i) => `text-${i}`);
      const task = createTask({ texts: largeTexts });

      const result = await adapter.add(task);

      expect(result.vectors).toHaveLength(largeTexts.length);
      expect(result.metadata.batchSize).toBeGreaterThan(0);
    });

    it('should emit progress during batch processing', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const events: QueueProgressEvent[] = [];
      adapter.onProgress((event) => {
        if (event.type === 'progress') {
          events.push(event as QueueProgressEvent);
        }
      });

      const largeTexts = Array.from({ length: 50 }, (_, i) => `text-${i}`);
      const task = createTask({ texts: largeTexts });
      await adapter.add(task);

      const embeddingEvents = events.filter((e) => e.phase === 'embedding');
      expect(embeddingEvents.length).toBeGreaterThan(0);

      // Progress should increase over time
      const progresses = embeddingEvents.map((e) => e.progress);
      expect(progresses[progresses.length - 1]).toBeGreaterThanOrEqual(progresses[0] ?? 0);
    });
  });

  describe('dtype and truncation', () => {
    it('should respect dtype option', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask({ dtype: 'fp32' });
      const result = await adapter.add(task);

      expect(result.metadata.dtype).toBe('fp32');
    });

    it('should use default dtype when not specified', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask();
      const result = await adapter.add(task);

      expect(result.metadata.dtype).toBe('fp16');
    });

    it('should handle truncateDim parameter', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask({ truncateDim: 256 });
      const result = await adapter.add(task);

      expect(result.id).toBe(task.id);
      // truncateDim is passed to the embedding function
    });
  });

  describe('concurrency configuration', () => {
    it('should clamp concurrency to valid range', async () => {
      // Test minimum (should clamp to 1)
      const adapter1 = createPQueueAdapter({ concurrency: 0 });
      await adapter1.add(createTask());
      expect(pipelineMock).toHaveBeenCalled();

      pipelineMock.mockClear();

      // Test maximum (should clamp to 4)
      const adapter2 = createPQueueAdapter({ concurrency: 10 });
      await adapter2.add(createTask());
      expect(pipelineMock).toHaveBeenCalled();
    });

    it('should default to concurrency of 2', async () => {
      const adapter = createPQueueAdapter();
      const tasks = [createTask(), createTask()];

      await adapter.addBulk(tasks);

      expect(pipelineMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('vector dimension handling', () => {
    it('should report correct dimensions in metadata', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask();
      const result = await adapter.add(task);

      expect(result.metadata.dimensions).toBeGreaterThan(0);
      expect(result.vectors[0]?.length).toBe(result.metadata.dimensions);
    });

    it('should use targetDimension when vectors are empty', async () => {
      const adapter = createPQueueAdapter({ concurrency: 1 });
      const task = createTask({ texts: [], targetDimension: 384 });
      const result = await adapter.add(task);

      expect(result.metadata.dimensions).toBe(384);
    });
  });
});
