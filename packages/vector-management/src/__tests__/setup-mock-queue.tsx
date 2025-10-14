import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import type React from 'react';
import { vi } from 'vitest';

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
    metrics: {
      active: 0,
      completed: 0,
      failed: 0,
      totalEnqueued: 0,
      lastError: null,
      progress: {},
    },
  }),
}));
