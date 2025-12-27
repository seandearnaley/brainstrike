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

function createMockService(overrides: Partial<VectorQueueService> = {}): VectorQueueService {
  return {
    backfill: vi.fn(async () => ({ queued: 0, running: 0, failed: 0, succeeded: 0 })),
    validateApiKeyForSet: vi.fn(async () => ({ valid: true as const })),
    retryFailed: vi.fn(),
    clearQueue: vi.fn(),
    wipeQueue: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

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

  describe('auto-backfill disabled behavior', () => {
    it('does NOT auto-backfill even when coverage incomplete and shouldAutoBackfill is true', async () => {
      liveQueryState.coverage.rows = [{ totalChunks: 10, chunksWithEmbeddingsForSet: 2 }];
      const service = createMockService();

      renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: true,
        })
      );

      await act(async () => Promise.resolve());

      // Auto-backfill is disabled - backfill should NOT be called automatically
      expect(service.backfill).not.toHaveBeenCalled();
    });

    it('does NOT auto-backfill when shouldAutoBackfill is false', async () => {
      liveQueryState.coverage.rows = [{ totalChunks: 10, chunksWithEmbeddingsForSet: 2 }];
      const service = createMockService();

      renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => Promise.resolve());

      expect(service.backfill).not.toHaveBeenCalled();
    });

    it('does NOT auto-backfill when coverage is zero (no chunks)', async () => {
      liveQueryState.coverage.rows = [{ totalChunks: 0, chunksWithEmbeddingsForSet: 0 }];
      const service = createMockService();

      renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: true,
        })
      );

      await act(async () => Promise.resolve());

      expect(service.backfill).not.toHaveBeenCalled();
    });

    it('does NOT auto-backfill when activeEmbeddingSetId is null', async () => {
      liveQueryState.coverage.rows = [{ totalChunks: 10, chunksWithEmbeddingsForSet: 2 }];
      const service = createMockService();

      renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: null,
          shouldAutoBackfill: true,
        })
      );

      await act(async () => Promise.resolve());

      expect(service.backfill).not.toHaveBeenCalled();
    });

    it('never auto-backfills even with coverage state changes', async () => {
      let coverageState = { totalChunks: 10, chunksWithEmbeddingsForSet: 2 };
      liveQueryState.coverage.rows = [coverageState];
      const backfillMock = vi.fn(async () => ({ queued: 0, running: 0, failed: 0, succeeded: 0 }));
      const service = createMockService({ backfill: backfillMock });

      const { rerender } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: true,
        })
      );

      await act(async () => Promise.resolve());
      expect(backfillMock).not.toHaveBeenCalled();

      // Simulate coverage reaching completion
      coverageState = { totalChunks: 10, chunksWithEmbeddingsForSet: 10 };
      liveQueryState.coverage.rows = [coverageState];
      await act(async () => {
        rerender();
        await Promise.resolve();
      });

      // Introduce new pending chunks for the same set
      coverageState = { totalChunks: 10, chunksWithEmbeddingsForSet: 4 };
      liveQueryState.coverage.rows = [coverageState];
      await act(async () => {
        rerender();
        await Promise.resolve();
      });

      // Still should not auto-backfill - it's disabled
      expect(backfillMock).not.toHaveBeenCalled();
    });

    it('never auto-backfills when switching embedding sets', async () => {
      liveQueryState.coverage.rows = [{ totalChunks: 10, chunksWithEmbeddingsForSet: 2 }];
      const service = createMockService();

      const { rerender } = renderHook(
        ({ setId }: { setId: string | null }) =>
          useVectorQueueState({
            service,
            activeEmbeddingSetId: setId,
            shouldAutoBackfill: true,
          }),
        { initialProps: { setId: 'set-1' } }
      );

      await act(async () => Promise.resolve());
      expect(service.backfill).not.toHaveBeenCalled();

      // Switch to a different set
      await act(async () => {
        rerender({ setId: 'set-2' });
        await Promise.resolve();
      });

      expect(service.backfill).not.toHaveBeenCalled();

      // Switch back
      await act(async () => {
        rerender({ setId: 'set-1' });
        await Promise.resolve();
      });

      expect(service.backfill).not.toHaveBeenCalled();
    });
  });

  describe('manual backfill functionality', () => {
    it('allows manual backfill via backfillActiveSet', async () => {
      liveQueryState.coverage.rows = [{ totalChunks: 10, chunksWithEmbeddingsForSet: 2 }];
      const backfillMock = vi.fn(async () => ({ queued: 5, running: 0, failed: 0, succeeded: 0 }));
      const service = createMockService({ backfill: backfillMock });

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => Promise.resolve());

      // No auto-backfill
      expect(backfillMock).not.toHaveBeenCalled();

      // Manual backfill
      await act(async () => {
        await result.current.backfillActiveSet();
      });

      expect(backfillMock).toHaveBeenCalledTimes(1);
      expect(backfillMock).toHaveBeenCalledWith('set-1', expect.any(Function));
    });

    it('does not call backfill when service is null', async () => {
      const { result } = renderHook(() =>
        useVectorQueueState({
          service: null,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => {
        await result.current.backfillActiveSet();
      });

      // No error thrown, just a no-op
      expect(result.current.backfilling).toBe(false);
    });

    it('does not call backfill when activeEmbeddingSetId is null', async () => {
      const service = createMockService();

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: null,
          shouldAutoBackfill: false,
        })
      );

      await act(async () => {
        await result.current.backfillActiveSet();
      });

      expect(service.backfill).not.toHaveBeenCalled();
    });

    it('sets backfilling state during manual backfill', async () => {
      let resolveBackfill: () => void;
      const backfillPromise = new Promise<{
        queued: number;
        running: number;
        failed: number;
        succeeded: number;
      }>((resolve) => {
        resolveBackfill = () => resolve({ queued: 0, running: 0, failed: 0, succeeded: 0 });
      });
      const backfillMock = vi.fn(() => backfillPromise);
      const service = createMockService({ backfill: backfillMock });

      liveQueryState.coverage.rows = [{ totalChunks: 10, chunksWithEmbeddingsForSet: 2 }];

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      expect(result.current.backfilling).toBe(false);

      // Start backfill (but don't await)
      let backfillDone = false;
      act(() => {
        result.current.backfillActiveSet().then(() => {
          backfillDone = true;
        });
      });

      // Should be backfilling now
      expect(result.current.backfilling).toBe(true);

      // Resolve the backfill
      await act(async () => {
        resolveBackfill!();
        await Promise.resolve();
      });

      // Should no longer be backfilling
      expect(result.current.backfilling).toBe(false);
      expect(backfillDone).toBe(true);
    });

    it('reports backfill progress via callback', async () => {
      let progressCallback: ((done: number, total: number) => void) | undefined;
      const backfillMock = vi.fn(
        async (_setId: string, onProgress: (done: number, total: number) => void) => {
          progressCallback = onProgress;
          return { queued: 0, running: 0, failed: 0, succeeded: 0 };
        }
      );
      const service = createMockService({ backfill: backfillMock });

      liveQueryState.coverage.rows = [{ totalChunks: 10, chunksWithEmbeddingsForSet: 2 }];

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => {
        await result.current.backfillActiveSet();
      });

      // Progress callback should have been passed
      expect(progressCallback).toBeDefined();
    });
  });

  describe('queue operations', () => {
    it('retryFailed calls service.retryFailed with limit', async () => {
      const retryFailedMock = vi.fn();
      const service = createMockService({ retryFailed: retryFailedMock });

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => {
        await result.current.retryFailed(10);
      });

      expect(retryFailedMock).toHaveBeenCalledWith(10);
    });

    it('retryFailed uses default limit of 20', async () => {
      const retryFailedMock = vi.fn();
      const service = createMockService({ retryFailed: retryFailedMock });

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => {
        await result.current.retryFailed();
      });

      expect(retryFailedMock).toHaveBeenCalledWith(20);
    });

    it('clearQueue calls service.clearQueue with failed states', async () => {
      const clearQueueMock = vi.fn();
      const service = createMockService({ clearQueue: clearQueueMock });

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => {
        await result.current.clearQueue();
      });

      expect(clearQueueMock).toHaveBeenCalledWith(['failed']);
    });

    it('wipeQueue calls service.wipeQueue', async () => {
      const wipeQueueMock = vi.fn();
      const service = createMockService({ wipeQueue: wipeQueueMock });

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => {
        await result.current.wipeQueue();
      });

      expect(wipeQueueMock).toHaveBeenCalled();
    });

    it('queue operations are no-op when service is null', async () => {
      const { result } = renderHook(() =>
        useVectorQueueState({
          service: null,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      // These should not throw
      await act(async () => {
        await result.current.retryFailed();
        await result.current.clearQueue();
        await result.current.wipeQueue();
      });
    });
  });

  describe('telemetry and metrics', () => {
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

    it('returns queue counts from live query', async () => {
      liveQueryState.queueCounts.rows = [{ queued: 5, running: 2, failed: 1, succeeded: 100 }];
      const service = createMockService();

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => Promise.resolve());

      expect(result.current.queueCounts).toEqual({
        queued: 5,
        running: 2,
        failed: 1,
        succeeded: 100,
      });
    });

    it('returns coverage from live query', async () => {
      liveQueryState.coverage.rows = [{ totalChunks: 100, chunksWithEmbeddingsForSet: 75 }];
      const service = createMockService();

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => Promise.resolve());

      expect(result.current.coverage).toEqual({
        total: 100,
        withSet: 75,
      });
    });

    it('returns default coverage when no activeEmbeddingSetId', async () => {
      liveQueryState.coverage.rows = [{ totalChunks: 100, chunksWithEmbeddingsForSet: 75 }];
      const service = createMockService();

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: null,
          shouldAutoBackfill: false,
        })
      );

      await act(async () => Promise.resolve());

      expect(result.current.coverage).toEqual({
        total: 0,
        withSet: 0,
      });
    });

    it('returns last error from live query', async () => {
      liveQueryState.lastError.rows = [{ error: 'Model loading failed' }];
      const service = createMockService();

      const { result } = renderHook(() =>
        useVectorQueueState({
          service,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
        })
      );

      await act(async () => Promise.resolve());

      expect(result.current.lastError).toBe('Model loading failed');
    });
  });
});
