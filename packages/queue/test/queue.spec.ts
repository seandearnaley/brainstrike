import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEmbeddingQueue } from '../src';
import { createPQueueAdapter } from '../src/adapters/browser-pqueue';
import { createWorkerpoolAdapter } from '../src/adapters/browser-workerpool';
import {
  addQueueTelemetryListener,
  createQueueTelemetryAggregator,
  emitQueueTelemetry,
  type QueueTelemetryEvent,
} from '../src/telemetry';

const workerpoolMocks = vi.hoisted(() => {
  const cancel = vi.fn();

  const createDefaultImplementation =
    () =>
    (
      _method: string,
      args: unknown[],
      options?: { readonly on?: (event: unknown) => void; readonly priority?: number }
    ): Promise<unknown> & { cancel: () => void } => {
      const [payload] = args;
      options?.on?.({
        type: 'progress',
        id: (payload as { id: string }).id,
        phase: 'embedding',
        progress: 0.5,
      });
      const result: any = Promise.resolve({
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
      });
      result.cancel = cancel;
      return result;
    };

  let implementation = createDefaultImplementation();

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
    },
    setImplementation(
      fn: (
        method: string,
        args: unknown[],
        options?: { readonly on?: (event: unknown) => void; readonly priority?: number }
      ) => Promise<unknown> & { cancel: () => void }
    ) {
      implementation = fn;
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

const pipelineMock = vi.fn(async () => async (inputs: string | readonly string[]) => {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  return list.map(() => Float32Array.from([0.25, 0.5, 0.25]));
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineMock,
  env: {},
  Tensor: MockTensor,
}));

const minimalTask = {
  kind: 'embed' as const,
  id: 'task-1',
  model: 'mock-model',
  texts: ['hello', 'world'],
};

beforeEach(() => {
  workerpoolMocks.reset();
  pipelineMock.mockClear();
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
      const promise: any = new Promise((resolve) => {
        resolveExec = resolve;
      });
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
});

describe('createPQueueAdapter', () => {
  it('embeds on the main thread and emits progress events', async () => {
    const adapter = createPQueueAdapter({ concurrency: 1 });
    const events: unknown[] = [];
    adapter.onProgress((event) => events.push(event));
    const result = await adapter.add(minimalTask);
    expect(result.vectors).toHaveLength(2);
    expect(events).not.toHaveLength(0);
    await adapter.drain();
  });
});

describe('queue telemetry', () => {
  it('emits telemetry events for the fallback p-queue adapter', async () => {
    const adapter = createPQueueAdapter({ concurrency: 1 });
    const events: QueueTelemetryEvent[] = [];
    const unsubscribe = addQueueTelemetryListener((event) => {
      if (event.taskId === 'telemetry-pqueue') {
        events.push(event);
      }
    });
    try {
      await adapter.add({ ...minimalTask, id: 'telemetry-pqueue' });
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.event === 'enqueue')).toBe(true);
    expect(events.some((event) => event.event === 'complete')).toBe(true);
  });

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

  it('aggregates throughput and latency over a sliding window', () => {
    const aggregator = createQueueTelemetryAggregator(60_000);
    const base = Date.now();
    emitQueueTelemetry({
      timestamp: base,
      adapter: 'pqueue',
      event: 'enqueue',
      taskId: 'aggregation-task',
    });
    emitQueueTelemetry({
      timestamp: base + 10,
      adapter: 'pqueue',
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
  it('prefers workerpool when Worker is available', async () => {
    setWorkerSupport();
    const queue = createBrowserEmbeddingQueue();
    const result = await queue.add(minimalTask);
    expect(result.metadata.device).toBe('webgpu');
  });

  it('falls back to p-queue when Worker is unavailable', async () => {
    (globalThis as Partial<typeof globalThis>).Worker = undefined;
    const queue = createBrowserEmbeddingQueue();
    const result = await queue.add({ ...minimalTask, id: 'task-fallback' });
    expect(result.metadata.device).toBe('wasm');
    expect(workerpoolMocks.execSpy).not.toHaveBeenCalled();
  });
});
