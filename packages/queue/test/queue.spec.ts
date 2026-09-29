import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerpoolAdapter as createWorkerpoolAdapterBase } from '../src/adapters/browser-workerpool.js';
import { createBrowserEmbeddingQueue } from '../src/browser.js';
import type { WorkerpoolAdapterOptions } from '../src/browser-workerpool-options.js';
import {
  addQueueTelemetryListener,
  createQueueTelemetryAggregator,
  emitQueueTelemetry,
  type QueueTelemetryEvent,
} from '../src/telemetry.js';

const TEST_WORKER_URL = 'https://example.invalid/embedding.worker.js';
const TEST_TELEMETRY_SINK = {
  recordBatch: vi.fn(),
  recordFailure: vi.fn(),
  recordPipelineCache: vi.fn(),
  removeSource: vi.fn(),
};

function createWorkerpoolAdapter(options: Omit<WorkerpoolAdapterOptions, 'telemetry'> = {}) {
  return createWorkerpoolAdapterBase({
    ...options,
    telemetry: TEST_TELEMETRY_SINK,
  });
}

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
        id: (payload as { id: string }).id,
        phase: 'embedding',
        progress: 0.5,
        type: 'progress',
      });
      const result: CancellablePromise = Promise.resolve({
        id: (payload as { id: string }).id,
        metadata: {
          batchSize: 2,
          device: 'webgpu',
          dimensions: 3,
          dtype: 'fp16',
          elapsedMs: 4,
          fallbackApplied: false,
          model: (payload as { model: string }).model,
        },
        type: 'result',
        vectors: [Float32Array.of(0.25, 0.5, 0.25)],
      }) as Promise<unknown> & { cancel: () => void };
      result.cancel = cancel;
      return result;
    };

  let implementation = createDefaultImplementation();
  let statsImpl: undefined | (() => { pendingTasks: number });
  let workerInstanceId: string | null = null;

  const execSpy = vi.fn<
    [
      method: string,
      args: unknown[],
      options?: { readonly on?: (event: unknown) => void; readonly priority?: number },
    ],
    Promise<unknown> & { cancel: () => void }
  >((method, args, options) => {
    if (workerInstanceId === null) {
      throw new Error('Expected the workerpool mock to create a managed worker.');
    }
    const [payload] = args;
    options?.on?.({
      cacheSize: 1,
      diagnostic: 'pipeline-cache',
      emittedAt: 100,
      entry: {
        cacheKey: 'local:test|webgpu|fp16',
        createdAt: 50,
        device: 'webgpu',
        dtype: 'fp16',
        lastUsedAt: 100,
        memory: { gpuBytes: 1024, heapBytes: 0, reason: 'model-size-estimate' },
        model: 'local:test',
        residencyMs: 50,
      },
      event: 'hit',
      id: (payload as { id: string }).id,
      type: 'diagnostic',
      workerInstanceId,
    });
    return implementation(method, args, options);
  });

  const poolSpy = vi.fn((script: unknown, options: unknown) => {
    const poolOptions = options as {
      onCreateWorker?: (args: {
        script?: string;
        workerOpts?: WorkerOptions;
      }) => { script?: string; workerOpts?: WorkerOptions } | undefined;
    };
    const createdWorker = poolOptions.onCreateWorker?.({
      script: typeof script === 'string' ? script : undefined,
      workerOpts: { type: 'module' },
    });
    const taggedScript = createdWorker?.script;
    if (!taggedScript) {
      throw new Error('Expected the adapter to tag its managed worker script.');
    }
    workerInstanceId = new URL(taggedScript).hash
      ? new URLSearchParams(new URL(taggedScript).hash.slice(1)).get(
          'brainstrike-embedding-worker-instance'
        )
      : null;
    if (workerInstanceId === null) {
      throw new Error('Expected the adapter to assign a managed worker identity.');
    }
    return {
      exec: execSpy,
      stats: statsImpl,
      terminate,
    };
  });

  return {
    cancel,
    execSpy,
    poolSpy,
    reset() {
      cancel.mockReset();
      terminate.mockReset();
      execSpy.mockClear();
      poolSpy.mockClear();
      implementation = createDefaultImplementation();
      statsImpl = undefined;
      workerInstanceId = null;
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
    terminate,
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

const minimalTask = {
  deviceHint: 'webgpu' as const,
  id: 'task-1',
  kind: 'embed' as const,
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
    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
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
    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
    await adapter.add({
      ...minimalTask,
      dimensionParameter: 'dimensions',
      provider: 'openai',
      targetDimension: 768,
    });
    const lastCall = workerpoolMocks.execSpy.mock.calls.at(-1);
    const payload = lastCall?.[1]?.[0] as
      | { provider?: string; targetDimension?: number; dimensionParameter?: string }
      | undefined;
    expect(payload).toMatchObject({
      dimensionParameter: 'dimensions',
      provider: 'openai',
      targetDimension: 768,
    });
  });

  it('waits while paused before dispatching jobs', async () => {
    setWorkerSupport();
    let resolveExec: ((value: unknown) => void) | undefined;
    workerpoolMocks.setImplementation((_method, args, options) => {
      const [payload] = args;
      options?.on?.({
        id: (payload as { id: string }).id,
        phase: 'embedding',
        progress: 0.25,
        type: 'progress',
      });
      const promise: CancellablePromise = new Promise((resolve) => {
        resolveExec = resolve;
      }) as CancellablePromise;
      promise.cancel = workerpoolMocks.cancel;
      return promise;
    });

    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
    adapter.pause();
    const pending = adapter.add(minimalTask);
    await Promise.resolve();
    expect(workerpoolMocks.execSpy).not.toHaveBeenCalled();
    adapter.resume();
    await Promise.resolve();
    expect(workerpoolMocks.execSpy).toHaveBeenCalledOnce();
    resolveExec?.({
      id: minimalTask.id,
      metadata: {
        batchSize: 1,
        device: 'webgpu',
        dimensions: 3,
        dtype: 'fp16',
        elapsedMs: 1,
        fallbackApplied: false,
        model: minimalTask.model,
      },
      type: 'result',
      vectors: [Float32Array.of(1, 0, 0)],
    });
    const result = await pending;
    expect(result.metadata.batchSize).toBe(1);
  });

  it('supports idempotent resume and cancel, and rejects adds after cancel', async () => {
    setWorkerSupport();
    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });

    adapter.resume();
    await adapter.cancel();
    await adapter.cancel();

    expect(workerpoolMocks.terminate).toHaveBeenCalledTimes(1);
    await expect(adapter.add(minimalTask)).rejects.toThrow('Adapter has been canceled');
  });

  describe('device-aware default sizing (BST-86)', () => {
    function withNavigatorGpu<T>(hasGpu: boolean, body: () => T): T {
      const navRef = globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined;
      const hadOwn = navRef ? Object.hasOwn(navRef, 'gpu') : false;
      const previous = navRef ? (navRef as { gpu?: unknown }).gpu : undefined;
      try {
        if (navRef) {
          if (hasGpu) {
            (navRef as { gpu?: unknown }).gpu = {} as unknown;
          } else {
            // Delete to test the absence path. Some engines define gpu as
            // non-configurable; in that case the test runs against whatever
            // the platform reports and still exercises the code path.
            try {
              (navRef as { gpu?: unknown }).gpu = undefined;
            } catch {
              (navRef as { gpu?: unknown }).gpu = undefined;
            }
          }
        }
        return body();
      } finally {
        if (navRef) {
          if (hadOwn) {
            (navRef as { gpu?: unknown }).gpu = previous;
          } else {
            try {
              (navRef as { gpu?: unknown }).gpu = undefined;
            } catch {
              (navRef as { gpu?: unknown }).gpu = undefined;
            }
          }
        }
      }
    }

    it('defaults to 1 worker when WebGPU is available (avoid model-copy memory spikes)', () => {
      setWorkerSupport();
      withNavigatorGpu(true, () => {
        createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
      });

      expect(workerpoolMocks.poolSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ maxWorkers: 1 })
      );
    });

    it('caps default workers at 4 when WebGPU is unavailable (safer on typical laptops)', () => {
      setWorkerSupport();
      withNavigatorGpu(false, () => {
        createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
      });

      const lastCall = workerpoolMocks.poolSpy.mock.calls.at(-1);
      const opts = lastCall?.[1] as { maxWorkers: number };
      expect(opts.maxWorkers).toBeLessThanOrEqual(4);
      expect(opts.maxWorkers).toBeGreaterThanOrEqual(1);
    });

    it('uses the CPU/WASM default when the caller selects wasm on a WebGPU-capable browser', () => {
      setWorkerSupport();
      const navRef = globalThis.navigator as Navigator & { hardwareConcurrency?: number };
      const previousHardwareConcurrency = Object.getOwnPropertyDescriptor(
        navRef,
        'hardwareConcurrency'
      );
      Object.defineProperty(navRef, 'hardwareConcurrency', {
        configurable: true,
        value: 8,
      });
      try {
        withNavigatorGpu(true, () => {
          createWorkerpoolAdapter({
            defaultDeviceHint: 'wasm',
            workerUrl: TEST_WORKER_URL,
          });
        });
      } finally {
        if (previousHardwareConcurrency) {
          Object.defineProperty(navRef, 'hardwareConcurrency', previousHardwareConcurrency);
        } else {
          Reflect.deleteProperty(navRef, 'hardwareConcurrency');
        }
      }

      const lastCall = workerpoolMocks.poolSpy.mock.calls.at(-1);
      const opts = lastCall?.[1] as { maxWorkers: number };
      expect(opts.maxWorkers).toBeGreaterThan(1);
      expect(opts.maxWorkers).toBeLessThanOrEqual(4);
    });

    it('respects an explicit maxWorkers override regardless of WebGPU presence', () => {
      setWorkerSupport();
      withNavigatorGpu(true, () => {
        createWorkerpoolAdapter({ maxWorkers: 3, workerUrl: TEST_WORKER_URL });
      });

      expect(workerpoolMocks.poolSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ maxWorkers: 3 })
      );
    });
  });

  describe('dispose() lifecycle (BST-86)', () => {
    it('exposes dispose() that terminates the pool and rejects subsequent adds', async () => {
      setWorkerSupport();
      const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });

      expect(typeof adapter.dispose).toBe('function');
      await adapter.dispose?.();

      expect(workerpoolMocks.terminate).toHaveBeenCalledTimes(1);
      await expect(adapter.add(minimalTask)).rejects.toThrow('Adapter has been disposed');
    });

    it('is idempotent — calling dispose() twice resolves without re-terminating', async () => {
      setWorkerSupport();
      const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });

      await adapter.dispose?.();
      await expect(adapter.dispose?.()).resolves.toBeUndefined();

      expect(workerpoolMocks.terminate).toHaveBeenCalledTimes(1);
    });

    it('keeps cancel and dispose terminal states distinct', async () => {
      setWorkerSupport();
      const canceledAdapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
      await canceledAdapter.cancel();

      expect(workerpoolMocks.terminate).toHaveBeenCalledTimes(1);
      await expect(canceledAdapter.add(minimalTask)).rejects.toThrow('Adapter has been canceled');

      workerpoolMocks.terminate.mockClear();
      const disposedAdapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
      await disposedAdapter.dispose?.();

      expect(workerpoolMocks.terminate).toHaveBeenCalledTimes(1);
      await expect(disposedAdapter.addBulk([minimalTask])).rejects.toThrow(
        'Adapter has been disposed'
      );
    });
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
          id: (payload as { id: string }).id,
          metadata: {
            batchSize: 1,
            device: 'webgpu',
            dimensions: 3,
            dtype: 'fp16',
            elapsedMs: 1,
            fallbackApplied: false,
            model: minimalTask.model,
          },
          type: 'result',
          vectors: [Float32Array.of(0.5, 0.5, 0.5)],
        });
      });

      return promise;
    });

    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      adapter.add({ ...minimalTask, id: 'pre-aborted' }, { signal: preAborted.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });

    const runtimeAbort = new AbortController();
    const pending = adapter.add(
      { ...minimalTask, id: 'runtime-abort' },
      { signal: runtimeAbort.signal }
    );
    runtimeAbort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    expect(workerpoolMocks.cancel).not.toHaveBeenCalled();
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
            id: (payload as { id: string }).id,
            metadata: {
              batchSize: 1,
              device: 'webgpu',
              dimensions: 3,
              dtype: 'fp16',
              elapsedMs: 2,
              fallbackApplied: false,
              model: minimalTask.model,
            },
            type: 'result',
            vectors: [Float32Array.of(0.1, 0.1, 0.1)],
          });
        }
      });

      return promise;
    });

    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
    const taskPromise = adapter.add({ ...minimalTask, id: 'drain-task' });
    await Promise.resolve();
    expect(adapter.isProcessing).toBe(true);

    await expect(adapter.drain()).resolves.toBeUndefined();
    await expect(taskPromise).resolves.toMatchObject({ id: 'drain-task', type: 'result' });
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
            id: (payload as { id: string }).id,
            metadata: {
              batchSize: 1,
              device: 'webgpu',
              dimensions: 3,
              dtype: 'fp16',
              elapsedMs: 2,
              fallbackApplied: false,
              model: minimalTask.model,
            },
            type: 'result',
            vectors: [Float32Array.of(0.2, 0.2, 0.2)],
          });
        });
      }) as CancellablePromise;
      promise.cancel = workerpoolMocks.cancel;
      return promise;
    });

    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
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
    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
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
    const adapter = createWorkerpoolAdapter({ workerUrl: TEST_WORKER_URL });
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
        expect.objectContaining({ event: 'enqueue', metadata: { pendingTasks: 7 }, pending: 7 }),
        expect.objectContaining({ event: 'complete', metadata: { pendingTasks: 7 }, pending: 7 }),
      ])
    );
  });

  it('aggregates throughput and latency over a sliding window', () => {
    const aggregator = createQueueTelemetryAggregator(60_000);
    const base = Date.now();
    emitQueueTelemetry({
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'aggregation-task',
      timestamp: base,
    });
    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 10,
      event: 'complete',
      taskId: 'aggregation-task',
      timestamp: base + 10,
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
    const queue = createBrowserEmbeddingQueue({
      worker: { telemetry: TEST_TELEMETRY_SINK, workerUrl: TEST_WORKER_URL },
    });
    const result = await queue.add(minimalTask);
    expect(result.metadata.device).toBe('webgpu');
  });

  it('throws when Worker is unavailable', () => {
    (globalThis as Partial<typeof globalThis>).Worker = undefined;
    expect(() =>
      createBrowserEmbeddingQueue({
        worker: { telemetry: TEST_TELEMETRY_SINK, workerUrl: TEST_WORKER_URL },
      })
    ).toThrow('Embedding queue requires Web Workers; this environment does not support them.');
  });

  it('fails fast when workerUrl is missing', () => {
    setWorkerSupport();
    expect(() => createWorkerpoolAdapter()).toThrow(
      'createWorkerpoolAdapter requires an explicit workerUrl.'
    );
    expect(() => createBrowserEmbeddingQueue()).toThrow(
      'createBrowserEmbeddingQueue requires an explicit worker.workerUrl.'
    );
  });

  it('fails fast when renderer telemetry composition is missing', () => {
    setWorkerSupport();
    // @ts-expect-error Exercise the runtime guard retained for untyped JavaScript callers.
    expect(() => createWorkerpoolAdapterBase({ workerUrl: TEST_WORKER_URL })).toThrow(
      'Workerpool embedding telemetry sink is required.'
    );
    // @ts-expect-error Exercise the runtime guard retained for untyped JavaScript callers.
    expect(() => createBrowserEmbeddingQueue({ worker: { workerUrl: TEST_WORKER_URL } })).toThrow(
      'Workerpool embedding telemetry sink is required.'
    );
  });
});
