import {
  getRegisteredEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import {
  emitQueueTelemetry,
  type QueueAdapter,
  type QueueErrorEvent,
  type QueueProgressEvent,
  type QueueResult,
  type TaskPayload,
} from '@brainstrike/queue';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let EmbeddingQueueProvider:
  | typeof import('../embedding-queue-provider').EmbeddingQueueProvider
  | null = null;
let useEmbeddingQueue: typeof import('../embedding-queue-provider').useEmbeddingQueue | null = null;
const slowHookTimeoutMs = 30_000;
type EmbeddingQueueModule = typeof import('../embedding-queue-provider');
type EmbeddingQueueContextValue = ReturnType<EmbeddingQueueModule['useEmbeddingQueue']>;
type QueueMetricsSnapshot = EmbeddingQueueContextValue['metrics'];

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('../embedding-queue-provider')>(
    '../embedding-queue-provider'
  );
  EmbeddingQueueProvider = actual.EmbeddingQueueProvider;
  useEmbeddingQueue = actual.useEmbeddingQueue;
}, slowHookTimeoutMs);

afterEach(() => {
  __resetVectorStatusUIStoreForTests();
  resetEmbeddingQueueFactory();
});

function createQueueResult(id: string): QueueResult {
  return {
    type: 'result',
    id,
    vectors: [Float32Array.of(0.1, 0.2)],
    metadata: {
      model: 'integration-model',
      device: 'webgpu',
      dtype: 'fp16',
      batchSize: 1,
      elapsedMs: 1,
      fallbackApplied: false,
      dimensions: 2,
    },
  };
}

function createTestQueue(): QueueAdapter {
  const listeners = new Set<Parameters<QueueAdapter['onProgress']>[0]>();

  const adapter: QueueAdapter = {
    async add(task) {
      listeners.forEach((listener) => {
        listener({ type: 'progress', id: task.id, phase: 'initializing', progress: 0 });
      });

      // Microtask to simulate async worker scheduling
      await Promise.resolve();

      listeners.forEach((listener) => {
        listener({ type: 'progress', id: task.id, phase: 'embedding', progress: 0.5 });
      });

      const result: QueueResult = {
        type: 'result',
        id: task.id,
        vectors: [Float32Array.of(0.1, 0.2)],
        metadata: {
          model: task.model,
          device: 'webgpu',
          dtype: 'fp16',
          batchSize: 1,
          elapsedMs: 1,
          fallbackApplied: false,
          dimensions: 2,
        },
      };

      listeners.forEach((listener) => {
        listener({ type: 'progress', id: task.id, phase: 'complete', progress: 1 });
      });

      return result;
    },
    async addBulk(tasks, opts) {
      return Promise.all(tasks.map((task) => adapter.add(task, opts)));
    },
    onProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pause() {},
    resume() {},
    async cancel() {},
    async drain() {},
    isPaused: false,
    isProcessing: false,
  };

  return adapter;
}

interface ManualQueueAdapter extends QueueAdapter {
  readonly addMock: ReturnType<typeof vi.fn<QueueAdapter['add']>>;
  readonly cancelMock: ReturnType<typeof vi.fn<QueueAdapter['cancel']>>;
  readonly drainMock: ReturnType<typeof vi.fn<QueueAdapter['drain']>>;
  emit: (event: QueueProgressEvent | QueueErrorEvent) => void;
  readonly pauseMock: ReturnType<typeof vi.fn<QueueAdapter['pause']>>;
  readonly resumeMock: ReturnType<typeof vi.fn<QueueAdapter['resume']>>;
}

function createManualQueueAdapter(): ManualQueueAdapter {
  const listeners = new Set<Parameters<QueueAdapter['onProgress']>[0]>();
  const addMock = vi.fn<QueueAdapter['add']>(async (task) => {
    if (task.id === 'fail-error') {
      throw new Error('embedding failed');
    }
    if (task.id === 'fail-string') {
      return Promise.reject('string failure');
    }
    if (task.id === 'fail-opaque') {
      return Promise.reject({ reason: 'opaque failure' });
    }
    return createQueueResult(task.id);
  });
  const cancelMock = vi.fn<QueueAdapter['cancel']>(async () => {});
  const drainMock = vi.fn<QueueAdapter['drain']>(async () => {});
  const pauseMock = vi.fn<QueueAdapter['pause']>(() => {});
  const resumeMock = vi.fn<QueueAdapter['resume']>(() => {});

  return {
    add: addMock,
    addMock,
    addBulk: async (tasks, opts) => Promise.all(tasks.map((task) => addMock(task, opts))),
    cancel: cancelMock,
    cancelMock,
    drain: drainMock,
    drainMock,
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    onProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pause: pauseMock,
    pauseMock,
    resume: resumeMock,
    resumeMock,
    get isPaused() {
      return true;
    },
    get isProcessing() {
      return true;
    },
  };
}

function createTask(id: string): TaskPayload {
  return {
    kind: 'embed',
    id,
    model: 'integration-model',
    texts: [`text for ${id}`],
    deviceHint: 'webgpu',
  };
}

describe('Embedding queue integration', () => {
  it('records active lifecycle metrics for queue-driven embeddings', async () => {
    if (!(EmbeddingQueueProvider && useEmbeddingQueue)) {
      throw new Error('Embedding queue provider not initialised');
    }
    const useEmbeddingQueueHook = useEmbeddingQueue;
    const queue = createTestQueue();
    const metricsSnapshots: Array<{
      active: number;
      completed: number;
      failed: number;
      totalEnqueued: number;
      lastError: string | null;
      progress: Record<string, unknown>;
    }> = [];

    function pushSnapshot(snapshot: {
      active: number;
      completed: number;
      failed: number;
      totalEnqueued: number;
      lastError: string | null;
      progress: Record<string, unknown>;
    }) {
      metricsSnapshots.push(snapshot);
      if (metricsSnapshots.length > 32) {
        metricsSnapshots.shift();
      }
    }

    function Harness() {
      const queueContext = useEmbeddingQueueHook!();
      if (!queueContext) {
        throw new Error('Embedding queue context not available');
      }
      const { queue: instrumentedQueue, metrics } = queueContext;
      const startedRef = useRef(false);

      useEffect(() => {
        pushSnapshot({
          active: metrics.active,
          completed: metrics.completed,
          failed: metrics.failed,
          totalEnqueued: metrics.totalEnqueued,
          lastError: metrics.lastError,
          progress: { ...metrics.progress },
        });
      }, [metrics]);

      useEffect(() => {
        if (startedRef.current) {
          return;
        }
        startedRef.current = true;
        void instrumentedQueue.add({
          kind: 'embed',
          id: 'job-1',
          model: 'integration-model',
          texts: ['hello embeddings'],
          deviceHint: 'webgpu',
        });
      }, [instrumentedQueue]);

      return null;
    }

    const Provider = EmbeddingQueueProvider;

    const view = render(
      <Provider adapter={queue}>
        <Harness />
      </Provider>
    );

    await waitFor(() => {
      const finalMetrics = metricsSnapshots.at(-1);
      expect(finalMetrics).toBeDefined();
      expect(finalMetrics).toMatchObject({
        active: 0,
        completed: 1,
        failed: 0,
        totalEnqueued: 1,
        lastError: null,
      });
    });

    view.unmount();

    const finalMetrics = metricsSnapshots.at(-1);
    expect(finalMetrics?.progress).toEqual({});

    expect(metricsSnapshots.some((snapshot) => snapshot.active === 1)).toBe(true);
    expect(metricsSnapshots.some((snapshot) => Object.hasOwn(snapshot.progress, 'job-1'))).toBe(
      true
    );
  });

  it('wraps adapter controls and records progress, success, and failure metrics', async () => {
    if (!(EmbeddingQueueProvider && useEmbeddingQueue)) {
      throw new Error('Embedding queue provider not initialised');
    }
    const Provider = EmbeddingQueueProvider;
    const useEmbeddingQueueHook = useEmbeddingQueue;
    const queue = createManualQueueAdapter();
    const metricsSnapshots: QueueMetricsSnapshot[] = [];
    const forwardedEvents: Array<QueueProgressEvent | QueueErrorEvent> = [];
    const contextRef: { current: EmbeddingQueueContextValue | null } = { current: null };

    function Harness() {
      const context = useEmbeddingQueueHook!();
      contextRef.current = context;
      const { metrics } = context;
      useEffect(() => {
        metricsSnapshots.push(metrics);
      }, [metrics]);
      return null;
    }

    const view = render(
      <Provider adapter={queue}>
        <Harness />
      </Provider>
    );

    await waitFor(() => {
      expect(contextRef.current).not.toBeNull();
      expect(getRegisteredEmbeddingQueueFactory()).not.toBeNull();
    });

    const instrumentedQueue = contextRef.current!.queue;
    expect(instrumentedQueue.isPaused).toBe(true);
    expect(instrumentedQueue.isProcessing).toBe(true);

    const unsubscribe = instrumentedQueue.onProgress((event) => {
      forwardedEvents.push(event);
    });

    await act(async () => {
      queue.emit({ type: 'progress', id: 'manual-job', phase: 'embedding', progress: 0.25 });
      queue.emit({ type: 'progress', id: 'manual-job', phase: 'embedding', progress: 0.25 });
    });

    await waitFor(() => {
      expect(contextRef.current?.metrics.progress['manual-job']).toMatchObject({
        id: 'manual-job',
        phase: 'embedding',
        progress: 0.25,
      });
    });
    expect(forwardedEvents).toHaveLength(2);

    unsubscribe();
    await act(async () => {
      queue.emit({ type: 'progress', id: 'manual-job', phase: 'complete', progress: 1 });
    });
    expect(forwardedEvents).toHaveLength(2);

    await act(async () => {
      const results = await instrumentedQueue.addBulk([createTask('bulk-1'), createTask('bulk-2')]);
      expect(results.map((result) => result.id)).toEqual(['bulk-1', 'bulk-2']);
      instrumentedQueue.pause();
      instrumentedQueue.resume();
      await instrumentedQueue.cancel();
      await instrumentedQueue.drain();
    });

    expect(queue.pauseMock).toHaveBeenCalledTimes(1);
    expect(queue.resumeMock).toHaveBeenCalledTimes(1);
    expect(queue.cancelMock).toHaveBeenCalledTimes(1);
    expect(queue.drainMock).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(contextRef.current?.metrics).toMatchObject({
        active: 0,
        completed: 2,
        failed: 0,
        totalEnqueued: 2,
      });
    });

    await act(async () => {
      await expect(instrumentedQueue.add(createTask('fail-error'))).rejects.toThrow(
        'embedding failed'
      );
      await expect(instrumentedQueue.add(createTask('fail-string'))).rejects.toBe('string failure');
      await expect(instrumentedQueue.add(createTask('fail-opaque'))).rejects.toEqual({
        reason: 'opaque failure',
      });
    });

    await waitFor(() => {
      expect(contextRef.current?.metrics).toMatchObject({
        active: 0,
        completed: 2,
        failed: 3,
        lastError: 'Unknown error',
        totalEnqueued: 5,
      });
    });

    view.unmount();
    expect(getRegisteredEmbeddingQueueFactory()).toBeNull();
    expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(false);

    expect(metricsSnapshots.some((snapshot) => snapshot.failed === 3)).toBe(true);
  });

  it('records queue telemetry snapshots when browser workers are available', async () => {
    if (!(EmbeddingQueueProvider && useEmbeddingQueue)) {
      throw new Error('Embedding queue provider not initialised');
    }
    const Provider = EmbeddingQueueProvider;
    const useEmbeddingQueueHook = useEmbeddingQueue;
    const originalWorker = window.Worker;
    const TestWorker = class {} as unknown as typeof Worker;
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      writable: true,
      value: TestWorker,
    });

    const contextRef: { current: EmbeddingQueueContextValue | null } = { current: null };

    try {
      function Harness() {
        const context = useEmbeddingQueueHook!();
        contextRef.current = context;
        return null;
      }

      const view = render(
        <Provider adapter={createManualQueueAdapter()}>
          <Harness />
        </Provider>
      );

      await waitFor(() => {
        expect(contextRef.current).not.toBeNull();
      });

      await act(async () => {
        emitQueueTelemetry({
          adapter: 'workerpool',
          elapsedMs: 40,
          event: 'complete',
          taskId: 'telemetry-success',
          timestamp: Date.now(),
        });
        emitQueueTelemetry({
          adapter: 'workerpool',
          errorMessage: 'worker failed',
          event: 'error',
          taskId: 'telemetry-error',
          timestamp: Date.now(),
        });
      });

      await waitFor(() => {
        expect(contextRef.current?.metrics).toMatchObject({
          latencyAvgMs: 40,
          latencyP50Ms: 40,
          latencyP95Ms: 40,
          throughputPerMinute: 1,
          windowErrorCount: 1,
        });
      });

      view.unmount();
    } finally {
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        writable: true,
        value: originalWorker,
      });
    }
  });
});
