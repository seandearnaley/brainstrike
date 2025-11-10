import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerpoolAdapter } from '../src/adapters/browser-workerpool';
import { addQueueTelemetryListener, type QueueTelemetryEvent } from '../src/telemetry';
import type { QueueResult, TaskPayload } from '../src/types';

// Mock workerpool
const workerpoolMocks = vi.hoisted(() => {
  const cancel = vi.fn();
  let stats = { pendingTasks: 0 };

  const createDefaultImplementation = () => {
    return (
      _method: string,
      args: unknown[],
      options?: { readonly on?: (event: unknown) => void }
    ): Promise<QueueResult> & { cancel: () => void } => {
      const [payload] = args;
      const id = (payload as { id: string }).id;

      // Emit progress event
      setTimeout(() => {
        options?.on?.({
          type: 'progress',
          id,
          phase: 'embedding',
          progress: 0.5,
        });
      }, 0);

      const result: Promise<QueueResult> & { cancel: () => void } = Promise.resolve({
        type: 'result',
        id,
        vectors: [Float32Array.of(0.25, 0.5, 0.25)],
        metadata: {
          model: (payload as { model: string }).model,
          device: 'webgpu',
          dtype: 'fp16',
          batchSize: 2,
          elapsedMs: 10,
          fallbackApplied: false,
          dimensions: 3,
        },
      }) as Promise<QueueResult> & { cancel: () => void };

      result.cancel = cancel;
      return result;
    };
  };

  let implementation = createDefaultImplementation();

  const execSpy = vi.fn<
    [
      method: string,
      args: unknown[],
      options?: { readonly on?: (event: unknown) => void }
    ],
    Promise<QueueResult> & { cancel: () => void }
  >((method, args, options) => implementation(method, args, options));

  const poolSpy = vi.fn((_script: unknown, _options: unknown) => ({
    exec: execSpy,
    stats: () => stats,
  }));

  return {
    cancel,
    execSpy,
    poolSpy,
    reset() {
      cancel.mockReset();
      execSpy.mockClear();
      poolSpy.mockClear();
      implementation = createDefaultImplementation();
      stats = { pendingTasks: 0 };
    },
    setImplementation(
      fn: (
        method: string,
        args: unknown[],
        options?: { readonly on?: (event: unknown) => void }
      ) => Promise<QueueResult> & { cancel: () => void }
    ) {
      implementation = fn;
    },
    setStats(newStats: { pendingTasks: number }) {
      stats = newStats;
    },
  };
});

vi.mock('workerpool', () => ({
  default: {
    pool: workerpoolMocks.poolSpy,
  },
  pool: workerpoolMocks.poolSpy,
}));

vi.mock('@brainstrike/embedding-worker', () => ({
  resolveEmbeddingWorkerUrl: () => new URL('https://example.test/worker.js'),
}));

// Mock utils
vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Setup Worker support
function setupWorkerEnvironment(): void {
  class FakeWorker {
    terminate(): void {
      // no-op
    }
  }
  // @ts-expect-error - injecting browser global
  globalThis.Worker = FakeWorker;
}

const createTask = (overrides: Partial<TaskPayload> = {}): TaskPayload => ({
  kind: 'embed',
  id: `task-${Math.random().toString(36).slice(2, 9)}`,
  model: 'test-model',
  texts: ['hello', 'world'],
  ...overrides,
});

describe('browser-workerpool adapter', () => {
  beforeEach(() => {
    setupWorkerEnvironment();
    workerpoolMocks.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Partial<typeof globalThis>).Worker;
  });

  describe('initialization', () => {
    it('should create worker pool with default options', () => {
      createWorkerpoolAdapter();

      expect(workerpoolMocks.poolSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          maxWorkers: expect.any(Number),
          maxQueueSize: Number.POSITIVE_INFINITY,
          workerType: 'web',
          workerOpts: { type: 'module' },
        })
      );
    });

    it('should respect maxWorkers option', () => {
      createWorkerpoolAdapter({ maxWorkers: 4 });

      expect(workerpoolMocks.poolSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          maxWorkers: 4,
        })
      );
    });

    it('should respect maxQueueSize option', () => {
      createWorkerpoolAdapter({ maxQueueSize: 100 });

      expect(workerpoolMocks.poolSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          maxQueueSize: 100,
        })
      );
    });

    it('should cap maxWorkers at 8', () => {
      createWorkerpoolAdapter({ maxWorkers: 20 });

      expect(workerpoolMocks.poolSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          maxWorkers: 8,
        })
      );
    });

    it('should ensure at least 1 worker', () => {
      createWorkerpoolAdapter({ maxWorkers: 0 });

      expect(workerpoolMocks.poolSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          maxWorkers: 1,
        })
      );
    });
  });

  describe('task execution', () => {
    it('should execute a single task successfully', async () => {
      const adapter = createWorkerpoolAdapter();
      const task = createTask();
      const result = await adapter.add(task);

      expect(result.type).toBe('result');
      expect(result.id).toBe(task.id);
      expect(result.vectors).toHaveLength(1);
      expect(result.metadata.device).toBe('webgpu');
      expect(workerpoolMocks.execSpy).toHaveBeenCalledWith(
        'runEmbedding',
        expect.any(Array),
        expect.objectContaining({ on: expect.any(Function) })
      );
    });

    it('should execute multiple tasks in bulk', async () => {
      const adapter = createWorkerpoolAdapter();
      const tasks = [createTask(), createTask(), createTask()];
      const results = await adapter.addBulk(tasks);

      expect(results).toHaveLength(3);
      expect(workerpoolMocks.execSpy).toHaveBeenCalledTimes(3);
      results.forEach((result, index) => {
        expect(result.id).toBe(tasks[index]?.id);
      });
    });

    it('should pass task payload to worker', async () => {
      const adapter = createWorkerpoolAdapter();
      const task = createTask({
        model: 'specific-model',
        texts: ['test text'],
        provider: 'openai',
        targetDimension: 1536,
      });
      await adapter.add(task);

      const lastCall = workerpoolMocks.execSpy.mock.calls[0];
      const payload = lastCall?.[1]?.[0] as Record<string, unknown> | undefined;
      expect(payload).toMatchObject({
        model: 'specific-model',
        texts: ['test text'],
        provider: 'openai',
        targetDimension: 1536,
      });
    });
  });

  describe('progress events', () => {
    it('should emit progress events during execution', async () => {
      const adapter = createWorkerpoolAdapter();
      const events: unknown[] = [];
      adapter.onProgress((event) => events.push(event));

      const task = createTask();
      await adapter.add(task);

      expect(events.length).toBeGreaterThan(0);
      const progressEvent = events.find(
        (e: unknown) => (e as { type: string }).type === 'progress'
      );
      expect(progressEvent).toBeDefined();
    });

    it('should support multiple progress listeners', async () => {
      const adapter = createWorkerpoolAdapter();
      const events1: unknown[] = [];
      const events2: unknown[] = [];

      adapter.onProgress((event) => events1.push(event));
      adapter.onProgress((event) => events2.push(event));

      await adapter.add(createTask());

      expect(events1.length).toBeGreaterThan(0);
      expect(events2).toEqual(events1);
    });

    it('should allow unsubscribing from progress events', async () => {
      const adapter = createWorkerpoolAdapter();
      const events: unknown[] = [];

      const unsubscribe = adapter.onProgress((event) => events.push(event));
      unsubscribe();

      await adapter.add(createTask());

      expect(events).toHaveLength(0);
    });

    it('should filter non-worker events', async () => {
      workerpoolMocks.setImplementation((_method, args, options) => {
        const [payload] = args;
        const id = (payload as { id: string }).id;

        // Emit invalid event
        setTimeout(() => {
          options?.on?.('invalid event');
          options?.on?.({ invalidShape: true });
          options?.on?.({ type: 'progress', id, phase: 'embedding', progress: 0.5 });
        }, 0);

        const result: Promise<QueueResult> & { cancel: () => void } = Promise.resolve({
          type: 'result',
          id,
          vectors: [Float32Array.of(1, 0, 0)],
          metadata: {
            model: 'test',
            device: 'webgpu',
            dtype: 'fp16',
            batchSize: 1,
            elapsedMs: 1,
            fallbackApplied: false,
            dimensions: 3,
          },
        }) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      const events: unknown[] = [];
      adapter.onProgress((event) => events.push(event));

      await adapter.add(createTask());

      // Only the valid progress event should be emitted
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'progress' });
    });
  });

  describe('pause and resume', () => {
    it('should pause task execution', async () => {
      let resolveTask: ((value: QueueResult) => void) | undefined;
      workerpoolMocks.setImplementation((_method, args) => {
        const [payload] = args;
        const result: Promise<QueueResult> & { cancel: () => void } = new Promise((resolve) => {
          resolveTask = resolve;
        }) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      adapter.pause();

      const task = createTask();
      const promise = adapter.add(task);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have executed yet
      expect(workerpoolMocks.execSpy).not.toHaveBeenCalled();

      adapter.resume();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now it should execute
      expect(workerpoolMocks.execSpy).toHaveBeenCalled();

      resolveTask?.({
        type: 'result',
        id: task.id,
        vectors: [Float32Array.of(1, 0, 0)],
        metadata: {
          model: 'test',
          device: 'webgpu',
          dtype: 'fp16',
          batchSize: 1,
          elapsedMs: 1,
          fallbackApplied: false,
          dimensions: 3,
        },
      });

      await promise;
    });

    it('should resume multiple waiting tasks', async () => {
      let resolveTasks: Array<(value: QueueResult) => void> = [];
      workerpoolMocks.setImplementation((_method, args) => {
        const [payload] = args;
        const id = (payload as { id: string }).id;
        const result: Promise<QueueResult> & { cancel: () => void } = new Promise((resolve) => {
          resolveTasks.push(resolve);
        }) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      adapter.pause();

      const tasks = [createTask(), createTask(), createTask()];
      const promises = tasks.map((task) => adapter.add(task));

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(workerpoolMocks.execSpy).not.toHaveBeenCalled();

      adapter.resume();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(workerpoolMocks.execSpy).toHaveBeenCalledTimes(3);

      // Resolve all tasks
      resolveTasks.forEach((resolve, index) => {
        resolve({
          type: 'result',
          id: tasks[index]?.id ?? 'unknown',
          vectors: [Float32Array.of(1, 0, 0)],
          metadata: {
            model: 'test',
            device: 'webgpu',
            dtype: 'fp16',
            batchSize: 1,
            elapsedMs: 1,
            fallbackApplied: false,
            dimensions: 3,
          },
        });
      });

      await Promise.all(promises);
    });

    it('should do nothing when resuming non-paused adapter', async () => {
      const adapter = createWorkerpoolAdapter();
      adapter.resume(); // Resume without pause

      await adapter.add(createTask());

      expect(workerpoolMocks.execSpy).toHaveBeenCalled();
    });
  });

  describe('drain', () => {
    it('should wait for all active tasks to complete', async () => {
      let resolveTasks: Array<(value: QueueResult) => void> = [];
      workerpoolMocks.setImplementation((_method, args) => {
        const [payload] = args;
        const id = (payload as { id: string }).id;
        const result: Promise<QueueResult> & { cancel: () => void } = new Promise((resolve) => {
          resolveTasks.push(resolve);
        }) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      const tasks = [createTask(), createTask()];
      const promises = tasks.map((task) => adapter.add(task));

      const drainPromise = adapter.drain();

      // Drain should not resolve yet
      let drained = false;
      drainPromise.then(() => {
        drained = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drained).toBe(false);

      // Complete all tasks
      resolveTasks.forEach((resolve, index) => {
        resolve({
          type: 'result',
          id: tasks[index]?.id ?? 'unknown',
          vectors: [Float32Array.of(1, 0, 0)],
          metadata: {
            model: 'test',
            device: 'webgpu',
            dtype: 'fp16',
            batchSize: 1,
            elapsedMs: 1,
            fallbackApplied: false,
            dimensions: 3,
          },
        });
      });

      await Promise.all(promises);
      await drainPromise;

      expect(drained).toBe(true);
    });

    it('should resolve immediately if no active tasks', async () => {
      const adapter = createWorkerpoolAdapter();
      const start = Date.now();
      await adapter.drain();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('abort signal handling', () => {
    it('should cancel task when signal is aborted', async () => {
      let taskStarted = false;
      workerpoolMocks.setImplementation(() => {
        taskStarted = true;
        const result: Promise<QueueResult> & { cancel: () => void } = new Promise(() => {
          // Never resolve
        }) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      const controller = new AbortController();
      const task = createTask();

      const promise = adapter.add(task, { signal: controller.signal });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(taskStarted).toBe(true);

      controller.abort();

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(workerpoolMocks.cancel).toHaveBeenCalled();

      // The promise may still be pending, that's ok
      await expect(Promise.race([promise, Promise.resolve('timeout')])).resolves.toBe('timeout');
    });

    it('should cancel task if signal is pre-aborted', async () => {
      const adapter = createWorkerpoolAdapter();
      const controller = new AbortController();
      controller.abort();

      const task = createTask();
      const promise = adapter.add(task, { signal: controller.signal });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(workerpoolMocks.cancel).toHaveBeenCalled();

      // Verify that execution didn't start
      await expect(Promise.race([promise, Promise.resolve('timeout')])).resolves.toBe('timeout');
    });

    it('should clean up abort listener after task completes', async () => {
      const adapter = createWorkerpoolAdapter();
      const controller = new AbortController();
      const task = createTask();

      await adapter.add(task, { signal: controller.signal });

      // Signal should have listener removed
      controller.abort();

      // cancel should not be called since task already completed
      expect(workerpoolMocks.cancel).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should propagate errors from worker', async () => {
      workerpoolMocks.setImplementation(() => {
        const result: Promise<QueueResult> & { cancel: () => void } = Promise.reject(
          new Error('Worker error')
        ) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      const task = createTask();

      await expect(adapter.add(task)).rejects.toThrow('Worker error');
    });

    it('should emit error events on failure', async () => {
      workerpoolMocks.setImplementation((_method, args, options) => {
        const [payload] = args;
        const id = (payload as { id: string }).id;

        setTimeout(() => {
          options?.on?.({
            type: 'error',
            id,
            message: 'Processing failed',
            cause: new Error('Processing failed'),
          });
        }, 0);

        const result: Promise<QueueResult> & { cancel: () => void } = Promise.reject(
          new Error('Processing failed')
        ) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      const events: unknown[] = [];
      adapter.onProgress((event) => events.push(event));

      const task = createTask();
      await expect(adapter.add(task)).rejects.toThrow('Processing failed');

      const errorEvent = events.find((e: unknown) => (e as { type: string }).type === 'error');
      expect(errorEvent).toBeDefined();
    });

    it('should handle non-Error exceptions', async () => {
      workerpoolMocks.setImplementation(() => {
        const result: Promise<QueueResult> & { cancel: () => void } = Promise.reject(
          'String error'
        ) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      await expect(adapter.add(createTask())).rejects.toBe('String error');
    });
  });

  describe('telemetry integration', () => {
    it('should emit telemetry events with correct adapter type', async () => {
      const adapter = createWorkerpoolAdapter();
      const telemetryEvents: QueueTelemetryEvent[] = [];
      const unsubscribe = addQueueTelemetryListener((event) => {
        if (event.adapter === 'workerpool') {
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
        expect(completeEvent?.elapsedMs).toBeGreaterThanOrEqual(0);
      } finally {
        unsubscribe();
      }
    });

    it('should include pool stats in telemetry when available', async () => {
      workerpoolMocks.setStats({ pendingTasks: 5 });

      const adapter = createWorkerpoolAdapter();
      const telemetryEvents: QueueTelemetryEvent[] = [];
      const unsubscribe = addQueueTelemetryListener((event) => {
        telemetryEvents.push(event);
      });

      try {
        await adapter.add(createTask());

        const enqueueEvent = telemetryEvents.find(
          (e) => e.event === 'enqueue' && e.adapter === 'workerpool'
        );
        expect(enqueueEvent?.pending).toBe(5);
        expect(enqueueEvent?.metadata).toMatchObject({ pendingTasks: 5 });
      } finally {
        unsubscribe();
      }
    });

    it('should emit error telemetry on failure', async () => {
      workerpoolMocks.setImplementation(() => {
        const result: Promise<QueueResult> & { cancel: () => void } = Promise.reject(
          new Error('Task failed')
        ) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      const telemetryEvents: QueueTelemetryEvent[] = [];
      const unsubscribe = addQueueTelemetryListener((event) => {
        if (event.adapter === 'workerpool') {
          telemetryEvents.push(event);
        }
      });

      try {
        const task = createTask();
        await expect(adapter.add(task)).rejects.toThrow('Task failed');

        const errorEvent = telemetryEvents.find((e) => e.event === 'error');
        expect(errorEvent).toBeDefined();
        expect(errorEvent?.errorMessage).toContain('Task failed');
        expect(errorEvent?.elapsedMs).toBeGreaterThanOrEqual(0);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('concurrent task tracking', () => {
    it('should track active task count', async () => {
      let resolveTasks: Array<(value: QueueResult) => void> = [];
      workerpoolMocks.setImplementation((_method, args) => {
        const [payload] = args;
        const id = (payload as { id: string }).id;
        const result: Promise<QueueResult> & { cancel: () => void } = new Promise((resolve) => {
          resolveTasks.push(resolve);
        }) as Promise<QueueResult> & { cancel: () => void };
        result.cancel = workerpoolMocks.cancel;
        return result;
      });

      const adapter = createWorkerpoolAdapter();
      const telemetryEvents: QueueTelemetryEvent[] = [];
      const unsubscribe = addQueueTelemetryListener((event) => {
        if (event.adapter === 'workerpool') {
          telemetryEvents.push(event);
        }
      });

      try {
        const tasks = [createTask(), createTask()];
        const promises = tasks.map((task) => adapter.add(task));

        // Complete first task
        resolveTasks[0]?.({
          type: 'result',
          id: tasks[0]?.id ?? '',
          vectors: [Float32Array.of(1, 0, 0)],
          metadata: {
            model: 'test',
            device: 'webgpu',
            dtype: 'fp16',
            batchSize: 1,
            elapsedMs: 1,
            fallbackApplied: false,
            dimensions: 3,
          },
        });

        await promises[0];

        // Complete second task
        resolveTasks[1]?.({
          type: 'result',
          id: tasks[1]?.id ?? '',
          vectors: [Float32Array.of(1, 0, 0)],
          metadata: {
            model: 'test',
            device: 'webgpu',
            dtype: 'fp16',
            batchSize: 1,
            elapsedMs: 1,
            fallbackApplied: false,
            dimensions: 3,
          },
        });

        await promises[1];

        // Check that activeBefore and activeAfter are tracked
        const completeEvents = telemetryEvents.filter((e) => e.event === 'complete');
        expect(completeEvents.length).toBe(2);
        expect(completeEvents.every((e) => 'activeBefore' in e && 'activeAfter' in e)).toBe(true);
      } finally {
        unsubscribe();
      }
    });
  });
});
