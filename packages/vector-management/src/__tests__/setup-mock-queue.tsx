import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import type React from 'react';
import { afterAll, vi } from 'vitest';

const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  writable: true,
  value: undefined,
});

afterAll(() => {
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: originalWorker,
  });
});

const noopResult: QueueResult = {
  type: 'result',
  id: 'test-noop',
  vectors: [],
  metadata: {
    model: 'test',
    device: 'wasm',
    dtype: 'fp16',
    batchSize: 0,
    elapsedMs: 0,
    fallbackApplied: false,
    dimensions: 0,
  },
};

type MockQueueMetrics = {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly totalEnqueued: number;
  readonly lastError: string | null;
  readonly progress: Record<string, unknown>;
  readonly throughputPerMinute: number;
  readonly latencyAvgMs: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly windowErrorCount: number;
};

const DEFAULT_QUEUE_METRICS: MockQueueMetrics = {
  active: 0,
  completed: 0,
  failed: 0,
  totalEnqueued: 0,
  lastError: null as string | null,
  progress: {},
  throughputPerMinute: 0,
  latencyAvgMs: null as number | null,
  latencyP50Ms: null as number | null,
  latencyP95Ms: null as number | null,
  windowErrorCount: 0,
};

let currentQueueMetrics: MockQueueMetrics = { ...DEFAULT_QUEUE_METRICS };

export function resetMockQueueMetrics(): void {
  currentQueueMetrics = { ...DEFAULT_QUEUE_METRICS };
}

export function patchMockQueueMetrics(patch: Partial<MockQueueMetrics>): void {
  currentQueueMetrics = { ...currentQueueMetrics, ...patch };
}

const noopQueue: QueueAdapter = {
  add: vi.fn(async () => noopResult),
  addBulk: vi.fn(async (tasks) => tasks.map(() => noopResult)),
  onProgress: () => () => {},
  pause: vi.fn(),
  resume: vi.fn(),
  drain: vi.fn(async () => {}),
};

vi.mock('../embedding-queue-provider', () => ({
  EmbeddingQueueProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useEmbeddingQueue: () => ({
    queue: noopQueue,
    metrics: currentQueueMetrics,
  }),
}));
