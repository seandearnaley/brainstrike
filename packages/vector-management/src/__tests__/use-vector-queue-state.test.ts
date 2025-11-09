import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVectorQueueState } from '../vector-status/use-vector-queue-state';
import type { VectorQueueService } from '../vector-status/vector-queue-service';
import { patchMockQueueMetrics, resetMockQueueMetrics } from './setup-mock-queue';

type LiveQueryShape = {
  rows: unknown[];
};

const liveQueryState: Record<
  'queueCounts' | 'throughput' | 'lastError' | 'latency' | 'coverage',
  LiveQueryShape
> = {
  queueCounts: {
    rows: [{ queued: 0, running: 0, failed: 0, succeeded: 0 }],
  },
  throughput: {
    rows: [{ count: 0 }],
  },
  lastError: {
    rows: [],
  },
  latency: {
    rows: [],
  },
  coverage: {
    rows: [],
  },
};

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    usePGliteLiveQuery: vi.fn(
      (options: { query: string; params?: readonly unknown[]; enabled?: boolean }) => {
        if (!options.enabled) {
          return { rows: [], loading: false, error: null, refresh: vi.fn() };
        }
        const query = options.query;
        if (query.includes("FILTER (WHERE state = 'queued'")) {
          return {
            rows: liveQueryState.queueCounts.rows,
            loading: false,
            error: null,
            refresh: vi.fn(),
          };
        }
        if (query.includes("INTERVAL '60 seconds'")) {
          return {
            rows: liveQueryState.throughput.rows,
            loading: false,
            error: null,
            refresh: vi.fn(),
          };
        }
        if (query.includes("state = 'failed'")) {
          return {
            rows: liveQueryState.lastError.rows,
            loading: false,
            error: null,
            refresh: vi.fn(),
          };
        }
        if (query.includes("INTERVAL '5 minutes'")) {
          return {
            rows: liveQueryState.latency.rows,
            loading: false,
            error: null,
            refresh: vi.fn(),
          };
        }
        if (query.includes('chunksWithEmbeddingsForSet')) {
          return {
            rows: liveQueryState.coverage.rows,
            loading: false,
            error: null,
            refresh: vi.fn(),
          };
        }
        return { rows: [], loading: false, error: null, refresh: vi.fn() };
      }
    ),
  };
});

describe('useVectorQueueState', () => {
  function resetLiveQueryData() {
    liveQueryState.queueCounts.rows = [{ queued: 0, running: 0, failed: 0, succeeded: 0 }];
    liveQueryState.throughput.rows = [{ count: 0 }];
    liveQueryState.lastError.rows = [];
    liveQueryState.latency.rows = [];
    liveQueryState.coverage.rows = [];
  }

  afterEach(() => {
    resetLiveQueryData();
    resetMockQueueMetrics();
  });

  it('triggers auto backfill when coverage incomplete and worker running', async () => {
    liveQueryState.coverage.rows = [{ totalChunks: 10, chunksWithEmbeddingsForSet: 2 }];
    const service: VectorQueueService = {
      backfill: vi.fn(async () => ({ queued: 0, running: 0, failed: 0, succeeded: 0 })),
      retryFailed: vi.fn(),
      clearQueue: vi.fn(),
      wipeQueue: vi.fn(),
      refresh: vi.fn(),
    };

    renderHook(() =>
      useVectorQueueState({
        service,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: true,
      })
    );

    await act(async () => Promise.resolve());

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

    // When the live query is disabled (service: null), metrics still drive telemetry but not HUD stats
    expect(result.current.throughput).toBe(0);
    expect(result.current.latencyStats).toEqual({ avgMs: 0, p50Ms: 0, p95Ms: 0 });
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

  it('restarts auto backfill when coverage becomes incomplete again', async () => {
    let coverageState = { totalChunks: 10, chunksWithEmbeddingsForSet: 2 };
    liveQueryState.coverage.rows = [coverageState];
    const backfillMock = vi.fn(async () => ({ queued: 0, running: 0, failed: 0, succeeded: 0 }));

    const service: VectorQueueService = {
      backfill: backfillMock,
      retryFailed: vi.fn(),
      clearQueue: vi.fn(),
      wipeQueue: vi.fn(),
      refresh: vi.fn(),
    };

    const { rerender } = renderHook(() =>
      useVectorQueueState({
        service,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: true,
      })
    );

    await act(async () => Promise.resolve());

    expect(backfillMock).toHaveBeenCalledTimes(1);

    // Simulate coverage reaching completion which should reset the auto-backfill guard.
    coverageState = { totalChunks: 10, chunksWithEmbeddingsForSet: 10 };
    liveQueryState.coverage.rows = [coverageState];
    await act(async () => {
      rerender();
      await Promise.resolve();
    });

    backfillMock.mockClear();

    // Introduce new pending chunks for the same set; auto backfill should trigger again.
    coverageState = { totalChunks: 10, chunksWithEmbeddingsForSet: 4 };
    liveQueryState.coverage.rows = [coverageState];
    await act(async () => {
      rerender();
      await Promise.resolve();
    });

    expect(backfillMock).toHaveBeenCalledTimes(1);
  });
});
