import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVectorQueueState } from '../vector-status/use-vector-queue-state';
import type { VectorQueueService } from '../vector-status/vector-queue-service';
import { patchMockQueueMetrics, resetMockQueueMetrics } from './setup-mock-queue';

describe('useVectorQueueState', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetMockQueueMetrics();
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

  it('reflects metrics from the embedding queue context', async () => {
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
    expect(result.current.telemetryTrend.length).toBeLessThanOrEqual(1);

    act(() => {
      patchMockQueueMetrics({
        active: 2,
        completed: 7,
        failed: 1,
        throughputPerMinute: 4.25,
        latencyAvgMs: 120,
        latencyP50Ms: 90,
        latencyP95Ms: 240,
        windowErrorCount: 3,
      });
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
    expect(result.current.telemetryTrend.length).toBeGreaterThan(0);
    const lastTelemetryPoint = result.current.telemetryTrend.at(-1);
    expect(lastTelemetryPoint).toBeDefined();
    if (lastTelemetryPoint) {
      expect(lastTelemetryPoint.throughput).toBeCloseTo(4.25, 2);
      expect(lastTelemetryPoint.latencyP95).toBe(240);
      expect(lastTelemetryPoint.errorCount).toBe(3);
    }
  });
});
