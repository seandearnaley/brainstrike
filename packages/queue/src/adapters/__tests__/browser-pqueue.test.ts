import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedTaskPayload } from '../../types';
import { createPQueueAdapter } from '../browser-pqueue';

const baseTask: Pick<EmbedTaskPayload, 'kind' | 'deviceHint'> = {
  kind: 'embed',
  deviceHint: 'wasm',
};

const makeTask = (
  overrides: Omit<EmbedTaskPayload, 'kind' | 'deviceHint'> &
    Partial<Pick<EmbedTaskPayload, 'deviceHint'>>
): EmbedTaskPayload => ({
  ...baseTask,
  ...overrides,
});

// Mock the logger
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock telemetry
const mockEmitQueueTelemetry = vi.hoisted(() => vi.fn());
vi.mock('../../telemetry', () => ({
  emitQueueTelemetry: mockEmitQueueTelemetry,
}));

// Mock embedding worker utilities
vi.mock('@brainstrike/embedding-worker', () => ({
  computeInitialBatchSize: vi.fn((total: number) => Math.min(total, 32)),
  l2Normalize: vi.fn((vector: Float32Array) => vector),
  truncateVector: vi.fn((vector: Float32Array) => vector),
  vectorsFromPipelineOutput: vi.fn(() => [new Float32Array([1, 2, 3])]),
}));

// Mock transformers
const mockPipeline = vi.fn();
const mockTensorCtor = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
  env: {
    allowRemoteModels: undefined,
  },
  Tensor: mockTensorCtor,
}));

describe('createPQueueAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Setup default mock pipeline
    mockPipeline.mockResolvedValue(async (inputs: string | readonly string[]) => {
      const dims = Array.isArray(inputs) ? [inputs.length, 3] : [1, 3];
      return {
        dims,
        data: new Float32Array(dims[0]! * dims[1]!).fill(0.5),
        tolist: () => [[0.5, 0.5, 0.5]],
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create adapter with default concurrency', () => {
    const adapter = createPQueueAdapter();

    expect(adapter).toBeDefined();
    expect(adapter.add).toBeInstanceOf(Function);
    expect(adapter.addBulk).toBeInstanceOf(Function);
    expect(adapter.onProgress).toBeInstanceOf(Function);
    expect(adapter.pause).toBeInstanceOf(Function);
    expect(adapter.resume).toBeInstanceOf(Function);
    expect(adapter.drain).toBeInstanceOf(Function);
  });

  it('should create adapter with custom concurrency', () => {
    const adapter = createPQueueAdapter({ concurrency: 4 });

    expect(adapter).toBeDefined();
  });

  it('should clamp concurrency between 1 and 4', () => {
    // Test minimum
    const adapter1 = createPQueueAdapter({ concurrency: 0 });
    expect(adapter1).toBeDefined();

    // Test maximum
    const adapter2 = createPQueueAdapter({ concurrency: 10 });
    expect(adapter2).toBeDefined();

    // Test negative
    const adapter3 = createPQueueAdapter({ concurrency: -5 });
    expect(adapter3).toBeDefined();
  });

  it('should emit telemetry on enqueue', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-1',
      model: 'test-model',
      texts: ['hello'],
    });

    const resultPromise = adapter.add(task);

    // Should emit enqueue telemetry
    expect(mockEmitQueueTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: 'pqueue',
        event: 'enqueue',
        taskId: 'task-1',
        model: 'test-model',
      })
    );

    await resultPromise;
  });

  it('should emit telemetry on completion', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-complete',
      model: 'test-model',
      texts: ['hello'],
    });

    await adapter.add(task);

    // Should emit complete telemetry with elapsed time
    expect(mockEmitQueueTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: 'pqueue',
        event: 'complete',
        taskId: 'task-complete',
        model: 'test-model',
        elapsedMs: expect.any(Number),
      })
    );
  });

  it('should emit enqueue and complete telemetry for successful tasks', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-success',
      model: 'test-model',
      texts: ['hello'],
    });

    await adapter.add(task);

    // Should emit both enqueue and complete telemetry
    expect(mockEmitQueueTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: 'pqueue',
        event: 'enqueue',
        taskId: 'task-success',
      })
    );

    expect(mockEmitQueueTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: 'pqueue',
        event: 'complete',
        taskId: 'task-success',
      })
    );
  });

  it('should handle priority in add options', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-priority',
      model: 'test-model',
      texts: ['hello'],
    });

    await adapter.add(task, { priority: 10 });

    // Telemetry should be emitted
    expect(mockEmitQueueTelemetry).toHaveBeenCalled();
  });

  it('should handle abort signal in add options', async () => {
    const adapter = createPQueueAdapter();

    const controller = new AbortController();
    const task: EmbedTaskPayload = makeTask({
      id: 'task-abort',
      model: 'test-model',
      texts: ['hello'],
    });

    const resultPromise = adapter.add(task, { signal: controller.signal });

    // Should accept signal without error
    await resultPromise;
  });

  it('should add bulk tasks', async () => {
    const adapter = createPQueueAdapter();

    const tasks: EmbedTaskPayload[] = [
      makeTask({ id: 'task-1', model: 'model-1', texts: ['text-1'] }),
      makeTask({ id: 'task-2', model: 'model-2', texts: ['text-2'] }),
      makeTask({ id: 'task-3', model: 'model-3', texts: ['text-3'] }),
    ];

    const results = await adapter.addBulk(tasks);

    expect(results).toHaveLength(3);
    expect(mockEmitQueueTelemetry).toHaveBeenCalledTimes(6); // 3 enqueue + 3 complete
  });

  it('should add bulk tasks with priority', async () => {
    const adapter = createPQueueAdapter();

    const tasks: EmbedTaskPayload[] = [
      makeTask({ id: 'task-1', model: 'model-1', texts: ['text-1'] }),
      makeTask({ id: 'task-2', model: 'model-2', texts: ['text-2'] }),
    ];

    await adapter.addBulk(tasks, { priority: 5 });

    expect(mockEmitQueueTelemetry).toHaveBeenCalled();
  });

  it('should pause and resume queue', () => {
    const adapter = createPQueueAdapter();

    expect(() => adapter.pause()).not.toThrow();
    expect(() => adapter.resume()).not.toThrow();
  });

  it('should drain queue', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-drain',
      model: 'test-model',
      texts: ['hello'],
    });

    adapter.add(task);

    await adapter.drain();

    // Queue should be empty after drain
    expect(mockLogger.debug).toHaveBeenCalledWith('Browser fallback queue drained');
  });

  it('should register and emit progress events', async () => {
    const adapter = createPQueueAdapter();
    const progressListener = vi.fn();

    const unsubscribe = adapter.onProgress(progressListener);

    const task: EmbedTaskPayload = makeTask({
      id: 'task-progress',
      model: 'test-model',
      texts: ['hello', 'world'],
    });

    await adapter.add(task);

    // Should emit progress events
    expect(progressListener).toHaveBeenCalled();

    // Verify progress event types
    const calls = progressListener.mock.calls;
    const events = calls.map((call) => call[0]);
    const types = events.map((event: { type: string }) => event.type);

    expect(types).toContain('progress');

    unsubscribe();
  });

  it('should unsubscribe progress listener', async () => {
    const adapter = createPQueueAdapter();
    const progressListener = vi.fn();

    const unsubscribe = adapter.onProgress(progressListener);
    unsubscribe();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-unsub',
      model: 'test-model',
      texts: ['hello'],
    });

    await adapter.add(task);

    // Should not emit to unsubscribed listener
    expect(progressListener).not.toHaveBeenCalled();
  });

  it('should handle empty texts array', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-empty',
      model: 'test-model',
      texts: [],
    });

    const result = await adapter.add(task);

    expect(result.type).toBe('result');
    expect(result.vectors).toEqual([]);
    expect(result.metadata.batchSize).toBe(0);
    expect(result.metadata.elapsedMs).toBe(0);
  });

  it('should handle single text', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-single',
      model: 'test-model',
      texts: ['single text'],
    });

    const result = await adapter.add(task);

    expect(result.type).toBe('result');
    expect(result.vectors.length).toBeGreaterThan(0);
  });

  it('should handle multiple texts', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-multiple',
      model: 'test-model',
      texts: ['text 1', 'text 2', 'text 3'],
    });

    const result = await adapter.add(task);

    expect(result.type).toBe('result');
    expect(result.id).toBe('task-multiple');
  });

  it('should handle task with dtype', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-dtype',
      model: 'test-model',
      texts: ['hello'],
      dtype: 'fp32',
    });

    const result = await adapter.add(task);

    expect(result.metadata.dtype).toBe('fp32');
  });

  it('should handle task with truncateDim', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-truncate',
      model: 'test-model',
      texts: ['hello'],
      truncateDim: 512,
    });

    const result = await adapter.add(task);

    expect(result.type).toBe('result');
  });

  it('should handle task with maxBatchSize', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-batch',
      model: 'test-model',
      texts: ['hello'],
      maxBatchSize: 16,
    });

    const result = await adapter.add(task);

    expect(result.type).toBe('result');
  });

  it('should handle task with deviceHint', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-device',
      model: 'test-model',
      texts: ['hello'],
      deviceHint: 'wasm',
    });

    const result = await adapter.add(task);

    expect(result.type).toBe('result');
  });

  it('should log completion with queue stats', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-log',
      model: 'test-model',
      texts: ['hello'],
    });

    await adapter.add(task);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Browser fallback embedding complete',
      expect.objectContaining({
        taskId: 'task-log',
        model: 'test-model',
        elapsedMs: expect.any(Number),
      })
    );
  });

  it('should emit progress events throughout task execution', async () => {
    const adapter = createPQueueAdapter();
    const progressListener = vi.fn();

    adapter.onProgress(progressListener);

    const task: EmbedTaskPayload = makeTask({
      id: 'task-progress-flow',
      model: 'test-model',
      texts: ['hello', 'world'],
    });

    await adapter.add(task);

    // Should emit multiple progress events
    expect(progressListener).toHaveBeenCalled();

    const events = progressListener.mock.calls.map((call) => call[0]);
    const eventTypes = events.map((event: { type?: string; phase?: string }) => ({
      type: event.type,
      phase: event.phase,
    }));

    // Should have progress events with different phases
    expect(events.length).toBeGreaterThan(0);
    expect(eventTypes).toContainEqual(expect.objectContaining({ type: 'progress' }));
  });

  it('should handle concurrent tasks with concurrency limit', async () => {
    const adapter = createPQueueAdapter({ concurrency: 2 });

    const tasks: EmbedTaskPayload[] = [
      makeTask({ id: 'task-1', model: 'model', texts: ['text-1'] }),
      makeTask({ id: 'task-2', model: 'model', texts: ['text-2'] }),
      makeTask({ id: 'task-3', model: 'model', texts: ['text-3'] }),
      makeTask({ id: 'task-4', model: 'model', texts: ['text-4'] }),
    ];

    const results = await Promise.all(tasks.map((task) => adapter.add(task)));

    expect(results).toHaveLength(4);
  });

  it('should return result with metadata', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-metadata',
      model: 'test-model',
      texts: ['hello'],
      dtype: 'fp16',
    });

    const result = await adapter.add(task);

    expect(result).toMatchObject({
      type: 'result',
      id: 'task-metadata',
      metadata: {
        model: 'test-model',
        device: 'wasm',
        dtype: 'fp16',
        fallbackApplied: true,
        elapsedMs: expect.any(Number),
      },
    });
  });

  it('should handle provider and targetDimension in task', async () => {
    const adapter = createPQueueAdapter();

    const task: EmbedTaskPayload = makeTask({
      id: 'task-provider',
      model: 'test-model',
      texts: ['hello'],
      provider: 'openai',
      targetDimension: 1536,
      dimensionParameter: 'dimensions',
    });

    const result = await adapter.add(task);

    expect(result.type).toBe('result');
  });

  it('should handle model caching across tasks', async () => {
    const adapter = createPQueueAdapter();

    const task1: EmbedTaskPayload = makeTask({
      id: 'task-cache-1',
      model: 'cached-model',
      texts: ['first'],
    });

    const task2: EmbedTaskPayload = makeTask({
      id: 'task-cache-2',
      model: 'cached-model',
      texts: ['second'],
    });

    const result1 = await adapter.add(task1);
    const result2 = await adapter.add(task2);

    // Both tasks should complete successfully
    expect(result1.type).toBe('result');
    expect(result2.type).toBe('result');
    expect(result1.metadata.model).toBe('cached-model');
    expect(result2.metadata.model).toBe('cached-model');
  });

  it('should cache embedder models', async () => {
    const adapter = createPQueueAdapter();

    const task1: EmbedTaskPayload = makeTask({
      id: 'task-1',
      model: 'same-model',
      texts: ['hello'],
    });

    const task2: EmbedTaskPayload = makeTask({
      id: 'task-2',
      model: 'same-model',
      texts: ['world'],
    });

    await adapter.add(task1);
    const initialCallCount = mockPipeline.mock.calls.length;

    await adapter.add(task2);
    const finalCallCount = mockPipeline.mock.calls.length;

    // Should not call pipeline again for same model (cached)
    expect(finalCallCount).toBe(initialCallCount);
  });

  it('should handle different models separately', async () => {
    const adapter = createPQueueAdapter();

    const task1: EmbedTaskPayload = makeTask({
      id: 'task-1',
      model: 'model-a',
      texts: ['hello'],
    });

    const task2: EmbedTaskPayload = makeTask({
      id: 'task-2',
      model: 'model-b',
      texts: ['world'],
    });

    await adapter.add(task1);
    await adapter.add(task2);

    // Both tasks should complete successfully
    expect(mockEmitQueueTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'complete', taskId: 'task-1' })
    );
    expect(mockEmitQueueTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'complete', taskId: 'task-2' })
    );
  });

  it('should emit initializing progress phase', async () => {
    const adapter = createPQueueAdapter();
    const progressListener = vi.fn();

    adapter.onProgress(progressListener);

    const task: EmbedTaskPayload = makeTask({
      id: 'task-init-phase',
      model: 'test-model',
      texts: ['hello'],
    });

    await adapter.add(task);

    const initEvents = progressListener.mock.calls
      .map((call) => call[0])
      .filter((event: { phase?: string }) => event.phase === 'initializing');

    expect(initEvents.length).toBeGreaterThan(0);
  });

  it('should emit embedding progress phase', async () => {
    const adapter = createPQueueAdapter();
    const progressListener = vi.fn();

    adapter.onProgress(progressListener);

    const task: EmbedTaskPayload = makeTask({
      id: 'task-embed-phase',
      model: 'test-model',
      texts: ['hello', 'world'],
    });

    await adapter.add(task);

    const embedEvents = progressListener.mock.calls
      .map((call) => call[0])
      .filter((event: { phase?: string }) => event.phase === 'embedding');

    expect(embedEvents.length).toBeGreaterThan(0);
  });

  it('should emit complete progress phase', async () => {
    const adapter = createPQueueAdapter();
    const progressListener = vi.fn();

    adapter.onProgress(progressListener);

    const task: EmbedTaskPayload = makeTask({
      id: 'task-complete-phase',
      model: 'test-model',
      texts: ['hello'],
    });

    await adapter.add(task);

    const completeEvents = progressListener.mock.calls
      .map((call) => call[0])
      .filter((event: { phase?: string }) => event.phase === 'complete');

    expect(completeEvents.length).toBeGreaterThan(0);
  });
});
