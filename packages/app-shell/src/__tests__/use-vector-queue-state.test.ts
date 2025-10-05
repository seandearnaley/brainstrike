import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVectorQueueState } from '../vector-status/use-vector-queue-state';
import type { VectorQueueService } from '../vector-status/vector-queue-service';

describe('useVectorQueueState', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers auto backfill when coverage incomplete and worker running', async () => {
    vi.useFakeTimers();

    const service: VectorQueueService = {
      refresh: vi.fn(async () => ({
        coverage: { total: 10, withSet: 2 },
        queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
        throughput: 0,
        lastError: null,
        latency: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
      })),
      backfill: vi.fn(async () => ({ queued: 0, running: 0, failed: 0, succeeded: 0 })),
      retryFailed: vi.fn(),
      clearQueue: vi.fn(),
      wipeQueue: vi.fn(),
    };

    renderHook(() =>
      useVectorQueueState({
        service,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: true,
        pollIntervalMs: 5,
      })
    );

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      vi.advanceTimersByTime(5);
      await Promise.resolve();
    });

    expect(service.backfill).toHaveBeenCalledTimes(1);
    expect(service.backfill).toHaveBeenCalledWith('set-1', expect.any(Function));
  });
});
