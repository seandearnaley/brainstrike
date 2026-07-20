/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';

import {
  dispatchEmbeddingSetUpdated,
  dispatchQueueDrained,
  dispatchQueueProgress,
  EMBEDDING_SET_UPDATED_EVENT,
  type EmbeddingSetUpdatedEventDetail,
  onEmbeddingSetUpdated,
  onQueueDrained,
  onQueueProgress,
  QUEUE_DRAINED_EVENT,
  QUEUE_PROGRESS_EVENT,
  type QueueDrainedEventDetail,
  type QueueProgressEventDetail,
} from '../browser-events';

describe('browser-events', () => {
  it('pins the wire-format event names', () => {
    // These names are a cross-package wire contract (dispatched in one package,
    // listened to in another). Renaming one side silently breaks the other, so
    // the literals are pinned here — the only file outside the module allowed
    // to spell them (see scripts/browser-events-literal-guard.mjs).
    expect(QUEUE_DRAINED_EVENT).toBe('brainstrike:queue-drained');
    expect(QUEUE_PROGRESS_EVENT).toBe('brainstrike:queue-progress');
    expect(EMBEDDING_SET_UPDATED_EVENT).toBe('brainstrike:embedding-set-updated');
  });

  it('delivers queue-drained detail to listeners and stops after unsubscribe', () => {
    const received: (QueueDrainedEventDetail | null)[] = [];
    const unsubscribe = onQueueDrained((detail) => {
      received.push(detail);
    });

    dispatchQueueDrained({ embeddingSetId: 'set-1', queue: 'embeddings' });
    expect(received).toEqual([{ embeddingSetId: 'set-1', queue: 'embeddings' }]);

    unsubscribe();
    dispatchQueueDrained({ embeddingSetId: 'set-2', queue: 'embeddings' });
    expect(received).toHaveLength(1);
  });

  it('supports the legacy detail-less queue-drained dispatch as a null detail', () => {
    const received: (QueueDrainedEventDetail | null)[] = [];
    const unsubscribe = onQueueDrained((detail) => {
      received.push(detail);
    });

    dispatchQueueDrained();
    expect(received).toEqual([null]);

    unsubscribe();
  });

  it('delivers queue-progress detail to listeners', () => {
    const detail: QueueProgressEventDetail = {
      chunkId: 'chunk-1',
      embeddingSetId: 'set-1',
      failed: 0,
      lastError: null,
      model: 'test-model',
      pending: 2,
      processed: 3,
      queue: 'embeddings',
      status: 'completed',
      totalQueued: 5,
    };
    const listener = vi.fn();
    const unsubscribe = onQueueProgress(listener);

    dispatchQueueProgress(detail);
    expect(listener).toHaveBeenCalledExactlyOnceWith(detail);

    unsubscribe();
  });

  it('delivers embedding-set-updated detail to listeners', () => {
    const detail: EmbeddingSetUpdatedEventDetail = { id: 'set-9', reason: 'updated' };
    const listener = vi.fn();
    const unsubscribe = onEmbeddingSetUpdated(listener);

    dispatchEmbeddingSetUpdated(detail);
    expect(listener).toHaveBeenCalledExactlyOnceWith(detail);

    unsubscribe();
  });

  it('is a no-op (not a crash) without a window, on both dispatch and listen', () => {
    const originalWindow = globalThis.window;
    // biome-ignore lint/performance/noDelete: simulating a windowless runtime
    delete (globalThis as { window?: unknown }).window;
    try {
      expect(() => {
        dispatchQueueDrained({ embeddingSetId: 'set-1', queue: 'embeddings' });
      }).not.toThrow();
      expect(() => onQueueDrained(() => undefined)()).not.toThrow();
    } finally {
      (globalThis as { window: unknown }).window = originalWindow;
    }
  });
});
