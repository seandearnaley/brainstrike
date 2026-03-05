import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEmbeddingQueue } from '../src';
import { createWorkerpoolAdapter } from '../src/adapters/browser-workerpool';
import {
  addQueueTelemetryListener,
  createQueueTelemetryAggregator,
  emitQueueTelemetry,
  type QueueTelemetryEvent,
} from '../src/telemetry';

type CancellablePromise = Promise<unknown> & { cancel: () => void };

const workerpoolMocks = vi.hoisted(() => {
  const cancel = vi.fn();
  const terminate = vi.fn(async () => undefined);

  const createDefaultImplementation =
    () =>
    (
      _method: string,
      args: unknown[],
      options?: { readonly on?: (event: unknown) => void; readonly priority?: number }
    ): CancellablePromise => {
      const [payload] = args;
      options?.on?.({
        type: 'progress',
        id: (payload as { id: string }).id,
        phase: 'embedding',
        progress: 0.5,
      });
      const result: CancellablePromise = Promise.resolve({
        type: 'result',
        id: (payload as { id: string }).id,
        vectors: [Float32Array.of(0.25, 0.5, 0.25)],
        metadata: {
          model: (payload as { model: string }).model,
          device: 'webgpu',
          dtype: 'fp16',
          batchSize: 2,
          elapsedMs: 4,
          fallbackApplied: false,
          dimensions: 3,
        },
      }) as Promise<unknown> & { cancel: () => void };
      result.cancel = cancel;
      return result;
    };

  let implementation = createDefaultImplementation();
  let statsImpl: undefined | (() => { pendingTasks: number });

  const execSpy = vi.fn<
    [
      method: string,
      args: unknown[],
      options?: { readonly on?: (event: unknown) => void; readonly priority?: number },
    ],
    Promise<unknown> & { cancel: () => void }
  >((method, args, options) => implementation(method, args, options));

  const poolSpy = vi.fn((_script: unknown, _options: unknown) => ({
    exec: execSpy,
    terminate,
    stats: statsImpl,
  }));

  return {
    cancel,
    execSpy,
    poolSpy,
    terminate,
    reset() {
      cancel.mockReset();
      terminate.mockReset();
      execSpy.mockClear();
      poolSpy.mockClear();
      implementation = createDefaultImplementation();
      statsImpl = undefined;
    },
    setImplementation(
      fn: (
        method: string,
        args: unknown[],
        options?: { readonly on?: (event: unknown) => void; readonly priority?: number }
      ) => CancellablePromise
    ) {
      implementation = fn;
    },
    setStatsImplementation(fn: undefined | (() => { pendingTasks: number })) {
      statsImpl = fn;
    },
  };
});

vi.mock('workerpool', () => ({
  default: {
    pool: workerpoolMocks.poolSpy,
  },
  pool: workerpoolMocks.poolSpy,
  worker: vi.fn(),
  workerEmit: vi.fn(),
}));

vi.mock('@brainstrike/embedding-worker', () => ({
  resolveEmbeddingWorkerUrl: () => new URL('https://example.invalid/embedding.worker.js'),
  computeInitialBatchSize: (total: number, preferred?: number) => {
    const heuristic = Math.ceil(total / 8);
    const cap = preferred ?? 16;
    return Math.max(1, Math.min(cap, heuristic));
  },
  l2Normalize: (vector: Float32Array) => vector,
  truncateVector: (vector: Float32Array) => vector,
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

const minimalTask = {
  kind: 'embed' as const,
  deviceHint: 'webgpu' as const,
  id: 'task-1',
  model: 'mock-model',
  texts: ['hello', 'world'],
};

beforeEach(() => {
  workerpoolMocks.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as Partial<typeof globalThis>).Worker = undefined;
  (globalThis as { window?: unknown }).window = undefined;
});

function setWorkerSupport(): void {
  class FakeWorker {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    terminate(): void {}
  }
  // @ts-expect-error: injecting browser global
  globalThis.Worker = FakeWorker;
  const windowRef = (globalThis as { window?: Record<string, unknown> }).window;
  if (typeof windowRef !== 'object' || windowRef === null) {
    (globalThis as { window?: Record<string, unknown> }).window = {};
  }
  (globalThis as { window: Record<string, unknown> }).window.Worker = FakeWorker;
}

describe('createWorkerpoolAdapter', () => {
  it('executes jobs through workerpool and surfaces progress', async () => {
    setWorkerSupport();
    const adapter = createWorkerpoolAdapter();
    const events: unknown[] = [];
    adapter.onProgress((event) => events.push(event));
    const result = await adapter.add(minimalTask);
    expect(result.metadata.device).toBe('webgpu');
    expect(events).toHaveLength(1);
    expect(workerpoolMocks.poolSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxWorkers: expect.any(Number) })
    );
    expect(workerpoolMocks.execSpy).toHaveBeenCalledWith(
      'runEmbedding',
      expect.any(Array),
      expect.any(Object)
    );
  });

  it('forwards provider embedding metadata to worker requests', async () => {
    setWorkerSupport();
    const adapter = createWorkerpoolAdapter();
    await adapter.add({
      ...minimalTask,
      provider: 'openai',
      targetDimension: 768,
      dimensionParameter: 'dimensions',
    });
    const lastCall = workerpoolMocks.execSpy.mock.calls.at(-1);
    const payload = lastCall?.[1]?.[0] as
      | { provider?: string; targetDimension?: number; dimensionParameter?: string }
      | undefined;
    expect(payload).toMatchObject({
      provider: 'openai',
      targetDimension: 768,
      dimensionParameter: 'dimensions',
    });
  });

  it('waits while paused before dispatching jobs', async () => {
    setWorkerSupport();
    let resolveExec: ((value: unknown) => void) | undefined;
    workerpoolMocks.setImplementation((_method, args, options) => {
      const [payload] = args;
      options?.on?.({
        type: 'progress',
        id: (payload as { id: string }).id,
        phase: 'embedding',
        progress: 0.25,
      });
      const promise: CancellablePromise = new Promise((resolve) => {
        resolveExec = resolve;
      }) as CancellablePromise;
      promise.cancel = workerpoolMocks.cancel;
      return promise;
    });

    const adapter = createWorkerpoolAdapter();
    adapter.pause();
    const pending = adapter.add(minimalTask);
    await Promise.resolve();
    expect(workerpoolMocks.execSpy).not.toHaveBeenCalled();
    adapter.resume();
    await Promise.resolve();
    expect(workerpoolMocks.execSpy).toHaveBeenCalledOnce();
    resolveExec?.({
      type: 'result',
      id: minimalTask.id,
      vectors: [Float32Array.of(1, 0, 0)],
      metadata: {
        model: minimalTask.model,
        device: 'webgpu',
        dtype: 'fp16',
        batchSize: 1,
        elapsedMs: 1,
        fallbackApplied: false,
        dimensions: 3,
      },
    });
    const result = await pending;
    expect(result.metadata.batchSize).toBe(1);
  });

  it('supports idempotent resume and cancel, and rejects adds after cancel', async () => {
    setWorkerSupport();
    const adapter = createWorkerpoolAdapter();

    adapter.resume();
    await adapter.cancel();
    await adapter.cancel();

    expect(workerpoolMocks.terminate).toHaveBeenCalledTimes(1);
    await expect(adapter.add(minimalTask)).rejects.toThrow('Adapter has been canceled');
  });

  it('cancels execution for pre-aborted and runtime-aborted signals', async () => {
    setWorkerSupport();
    let resolveExec: ((value: unknown) => void) | undefined;
    workerpoolMocks.setImplementation((_method, args) => {
      const [payload] = args;
      const promise: CancellablePromise = new Promise((resolve) => {
        resolveExec = resolve;
      }) as CancellablePromise;
      promise.cancel = workerpoolMocks.cancel;

      queueMicrotask(() => {
        resolveExec?.({
          type: 'result',
          id: (payload as { id: string }).id,
          vectors: [Float32Array.of(0.5, 0.5, 0.5)],
          metadata: {
            model: minimalTask.model,
            device: 'webgpu',
            dtype: 'fp16',
            batchSize: 1,
            elapsedMs: 1,
            fallbackApplied: false,
            dimensions: 3,
          },
        });
      });

      return promise;
    });

    const adapter = createWorkerpoolAdapter();

    const preAborted = new AbortController();
    preAborted.abort();
    await adapter.add({ ...minimalTask, id: 'pre-aborted' }, { signal: preAborted.signal });

    const runtimeAbort = new AbortController();
    const pending = adapter.add(
      { ...minimalTask, id: 'runtime-abort' },
      { signal: runtimeAbort.signal }
    );
    runtimeAbort.abort();
    await pending;

    expect(workerpoolMocks.cancel).toHaveBeenCalledTimes(2);
  });

  it('waits for in-flight tasks when drain() is called', async () => {
    setWorkerSupport();
    let resolveExec: ((value: unknown) => void) | undefined;
    workerpoolMocks.setImplementation((_method, args) => {
      const [payload] = args;
      const promise: CancellablePromise = new Promise((resolve) => {
        resolveExec = resolve;
      }) as CancellablePromise;
      promise.cancel = workerpoolMocks.cancel;

      queueMicrotask(() => {
        if (resolveExec !== undefined) {
          resolveExec({
            type: 'result',
            id: (payload as { id: string }).id,
            vectors: [Float32Array.of(0.1, 0.1, 0.1)],
            metadata: {
              model: minimalTask.model,
              device: 'webgpu',
              dtype: 'fp16',
              batchSize: 1,
              elapsedMs: 2,
              fallbackApplied: false,
              dimensions: 3,
            },
          });
        }
      });

      return promise;
    });

    const adapter = createWorkerpoolAdapter();
    const taskPromise = adapter.add({ ...minimalTask, id: 'drain-task' });
    await Promise.resolve();
    expect(adapter.isProcessing).toBe(true);

    await expect(adapter.drain()).resolves.toBeUndefined();
    await expect(taskPromise).resolves.toMatchObject({ type: 'result', id: 'drain-task' });
    expect(adapter.isProcessing).toBe(false);
  });

  it('waits for active tasks during cancel() cleanup', async () => {
    setWorkerSupport();
    workerpoolMocks.setImplementation((_method, args) => {
      const [payload] = args;
      const promise: CancellablePromise = new Promise((resolve, reject) => {
        queueMicrotask(() => {
          if ((payload as { id: string }).id === 'cancel-task') {
            reject(new Error('canceled by worker termination'));
            return;
          }
          resolve({
            type: 'result',
            id: (payload as { id: string }).id,
            vectors: [Float32Array.of(0.2, 0.2, 0.2)],
            metadata: {
              model: minimalTask.model,
              device: 'webgpu',
              dtype: 'fp16',
              batchSize: 1,
              elapsedMs: 2,
              fallbackApplied: false,
              dimensions: 3,
            },
          });
        });
      }) as CancellablePromise;
      promise.cancel = workerpoolMocks.cancel;
      return promise;
    });

    const adapter = createWorkerpoolAdapter();
    const taskPromise = adapter.add({ ...minimalTask, id: 'cancel-task' });

    await expect(adapter.cancel()).resolves.toBeUndefined();
    await expect(taskPromise).rejects.toThrow('canceled by worker termination');
    expect(workerpoolMocks.terminate).toHaveBeenCalledTimes(1);
    expect(adapter.isPaused).toBe(true);
    expect(adapter.isProcessing).toBe(false);
  });
});

describe('queue telemetry', () => {
  it('emits telemetry events for the workerpool adapter', async () => {
    setWorkerSupport();
    const adapter = createWorkerpoolAdapter();
    const events: QueueTelemetryEvent[] = [];
    const unsubscribe = addQueueTelemetryListener((event) => {
      if (event.taskId === 'telemetry-workerpool') {
        events.push(event);
      }
    });
    try {
      await adapter.add({ ...minimalTask, id: 'telemetry-workerpool' });
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.event === 'enqueue')).toBe(true);
    expect(events.some((event) => event.event === 'complete')).toBe(true);
  });

  it('includes workerpool pending-task metadata when pool stats are available', async () => {
    setWorkerSupport();
    workerpoolMocks.setStatsImplementation(() => ({ pendingTasks: 7 }));
    const adapter = createWorkerpoolAdapter();
    const events: QueueTelemetryEvent[] = [];

    const unsubscribe = addQueueTelemetryListener((event) => {
      if (event.taskId === 'telemetry-stats') {
        events.push(event);
      }
    });
    try {
      await adapter.add({ ...minimalTask, id: 'telemetry-stats' });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'enqueue', pending: 7, metadata: { pendingTasks: 7 } }),
        expect.objectContaining({ event: 'complete', pending: 7, metadata: { pendingTasks: 7 } }),
      ])
    );
  });

  it('aggregates throughput and latency over a sliding window', () => {
    const aggregator = createQueueTelemetryAggregator(60_000);
    const base = Date.now();
    emitQueueTelemetry({
      timestamp: base,
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'aggregation-task',
    });
    emitQueueTelemetry({
      timestamp: base + 10,
      adapter: 'workerpool',
      event: 'complete',
      taskId: 'aggregation-task',
      elapsedMs: 10,
    });

    const snapshot = aggregator.snapshot(base + 20);
    aggregator.dispose();

    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.throughputPerMinute).toBeCloseTo(1, 5);
    expect(snapshot.averageLatencyMs).toBe(10);
    expect(snapshot.latencyP50Ms).toBe(10);
    expect(snapshot.latencyP95Ms).toBe(10);
    expect(snapshot.errorCount).toBe(0);
  });
});

describe('createBrowserEmbeddingQueue', () => {
  it('uses workerpool when Worker is available', async () => {
    setWorkerSupport();
    const queue = createBrowserEmbeddingQueue();
    const result = await queue.add(minimalTask);
    expect(result.metadata.device).toBe('webgpu');
  });

  it('throws when Worker is unavailable', () => {
    (globalThis as Partial<typeof globalThis>).Worker = undefined;
    expect(() => createBrowserEmbeddingQueue()).toThrow(
      'Embedding queue requires Web Workers; this environment does not support them.'
    );
  });
});
