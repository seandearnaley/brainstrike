import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { render, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let EmbeddingQueueProvider:
  | typeof import('../embedding-queue-provider').EmbeddingQueueProvider
  | null = null;
let useEmbeddingQueue: typeof import('../embedding-queue-provider').useEmbeddingQueue | null = null;

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('../embedding-queue-provider')>(
    '../embedding-queue-provider'
  );
  EmbeddingQueueProvider = actual.EmbeddingQueueProvider;
  useEmbeddingQueue = actual.useEmbeddingQueue;
});

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
    async drain() {},
  };

  return adapter;
}

describe('Embedding queue integration', () => {
  it('records active lifecycle metrics for queue-driven embeddings', async () => {
    if (!EmbeddingQueueProvider || !useEmbeddingQueue) {
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
});
