import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import type React from 'react';
import { afterAll, vi } from 'vitest';

const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  value: undefined,
  writable: true,
});

afterAll(() => {
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: originalWorker,
    writable: true,
  });
});

const noopResult: QueueResult = {
  id: 'test-noop',
  metadata: {
    batchSize: 0,
    device: 'wasm',
    dimensions: 0,
    dtype: 'fp16',
    elapsedMs: 0,
    fallbackApplied: false,
    model: 'test',
    pooling: 'mean',
  },
  type: 'result',
  vectors: [],
};

interface MockQueueMetrics {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly lastError: string | null;
  readonly latencyAvgMs: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly progress: Record<string, unknown>;
  readonly throughputPerMinute: number;
  readonly totalEnqueued: number;
  readonly windowErrorCount: number;
}

const DEFAULT_QUEUE_METRICS: MockQueueMetrics = {
  active: 0,
  completed: 0,
  failed: 0,
  lastError: null as string | null,
  latencyAvgMs: null as number | null,
  latencyP50Ms: null as number | null,
  latencyP95Ms: null as number | null,
  progress: {},
  throughputPerMinute: 0,
  totalEnqueued: 0,
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
  cancel: vi.fn(async () => {}),
  drain: vi.fn(async () => {}),
  isPaused: false,
  isProcessing: false,
  onProgress: () => () => {},
  pause: vi.fn(),
  resume: vi.fn(),
};

vi.mock('../embedding-queue-provider', () => ({
  EmbeddingQueueProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useEmbeddingQueue: () => ({
    metrics: currentQueueMetrics,
    queue: noopQueue,
  }),
  useEmbeddingQueueSafe: () => ({
    metrics: currentQueueMetrics,
    queue: noopQueue,
  }),
}));
