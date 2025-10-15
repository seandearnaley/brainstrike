import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVectorQueueState } from '../vector-status/use-vector-queue-state';
import type { VectorQueueService } from '../vector-status/vector-queue-service';
import { mockQueueMetrics } from './setup-mock-queue';

describe('useVectorQueueState', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(mockQueueMetrics, {
      active: 0,
      completed: 0,
      failed: 0,
      totalEnqueued: 0,
      lastError: null,
      progress: {},
      throughputPerMinute: 0,
      latencyAvgMs: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      windowErrorCount: 0,
    });
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

  it.skip('reflects metrics from the embedding queue context (temporarily skipped due to high memory usage)', async () => {
    const { result, rerender } = renderHook(() =>
      useVectorQueueState({
        service: null,
        activeEmbeddingSetId: null,
        shouldAutoBackfill: false,
      })
    );

    expect(result.current.throughput).toBe(0);
    expect(result.current.recentErrorCount).toBe(0);
    expect(result.current.latencyStats).toEqual({ avgMs: 0, p50Ms: 0, p95Ms: 0 });

    act(() => {
      mockQueueMetrics.active = 2;
      mockQueueMetrics.completed = 7;
      mockQueueMetrics.failed = 1;
      mockQueueMetrics.throughputPerMinute = 4.25;
      mockQueueMetrics.latencyAvgMs = 120;
      mockQueueMetrics.latencyP50Ms = 90;
      mockQueueMetrics.latencyP95Ms = 240;
      mockQueueMetrics.windowErrorCount = 3;
    });

    await act(async () => {
      rerender();
      await Promise.resolve();
    });

    expect(result.current.queueCounts).toEqual({
      queued: 2,
      running: 2,
      failed: 1,
      succeeded: 7,
    });
    expect(result.current.throughput).toBeCloseTo(4.25, 2);
    expect(result.current.latencyStats).toEqual({ avgMs: 120, p50Ms: 90, p95Ms: 240 });
    expect(result.current.recentErrorCount).toBe(3);
  });
});
