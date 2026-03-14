import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbeddingRuntimeBackfillProgress,
  EmbeddingRuntimeController,
} from '../vector-status/embedding-runtime-controller';
import { useVectorQueueState } from '../vector-status/use-vector-queue-state';
import type { VectorQueueService } from '../vector-status/vector-queue-service';
import { patchMockQueueMetrics, resetMockQueueMetrics } from './setup-mock-queue';

const vectorStatusUiStoreState = {
  durableQueueStats: null as null | {
    failed: number;
    nextRunnableAt: string | null;
    queued: number;
    running: number;
    succeeded: number;
  },
  setIsJobQueueActive: vi.fn(),
};

interface LiveQueryShape {
  rows: unknown[];
}

const liveQueryRefresh = {
  queueCounts: vi.fn(async () => {}),
  throughput: vi.fn(async () => {}),
  lastError: vi.fn(async () => {}),
  latency: vi.fn(async () => {}),
  coverage: vi.fn(async () => {}),
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
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    usePGliteLiveQuery: vi.fn(
      (options: { query: string; params?: readonly unknown[]; enabled?: boolean }) => {
        if (!options.enabled) {
          return { rows: [], loading: false, error: null, refresh: vi.fn(async () => {}) };
        }
        const query = options.query;
        if (query.includes("FILTER (WHERE state = 'queued'")) {
          return {
            rows: liveQueryState.queueCounts.rows,
            loading: false,
            error: null,
            refresh: liveQueryRefresh.queueCounts,
          };
        }
        if (query.includes("INTERVAL '60 seconds'")) {
          return {
            rows: liveQueryState.throughput.rows,
            loading: false,
            error: null,
            refresh: liveQueryRefresh.throughput,
          };
        }
        if (query.includes("state = 'failed'")) {
          return {
            rows: liveQueryState.lastError.rows,
            loading: false,
            error: null,
            refresh: liveQueryRefresh.lastError,
          };
        }
        if (query.includes("INTERVAL '5 minutes'")) {
          return {
            rows: liveQueryState.latency.rows,
            loading: false,
            error: null,
            refresh: liveQueryRefresh.latency,
          };
        }
        if (query.includes('chunksWithEmbeddingsForSet')) {
          return {
            rows: liveQueryState.coverage.rows,
            loading: false,
            error: null,
            refresh: liveQueryRefresh.coverage,
          };
        }
        return { rows: [], loading: false, error: null, refresh: vi.fn(async () => {}) };
      }
    ),
  };
});

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', () => ({
  useVectorStatusUIStore: vi.fn((selector: (state: typeof vectorStatusUiStoreState) => unknown) =>
    selector(vectorStatusUiStoreState)
  ),
}));

interface MockController {
  readonly controller: EmbeddingRuntimeController;
  readonly emitBackfillProgress: (progress: EmbeddingRuntimeBackfillProgress) => void;
  readonly enqueueBackfillMock: ReturnType<typeof vi.fn>;
}

function createRuntimeStatus(
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping'
): Awaited<ReturnType<EmbeddingRuntimeController['getStatus']>> {
  return {
    runtimeKind: 'embedding-worker',
    runtimeId: 'embedding-worker:test',
    state,
    active: false,
    lastError: null,
  };
}

function createMockService(overrides: Partial<VectorQueueService> = {}): VectorQueueService {
  return {
    backfill: vi.fn(async () => ({ queued: 0, running: 0, failed: 0, succeeded: 0 })),
    validateApiKeyForSet: vi.fn(async () => ({ valid: true as const })),
    reembedSet: vi.fn(async () => ({
      clearedCount: 0,
      queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
    })),
    retryFailed: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    wipeQueue: vi.fn(async () => {}),
    refresh: vi.fn(async () => ({
      coverage: null,
      lastError: null,
      latency: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
      queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
      throughput: 0,
    })),
    ...overrides,
  };
}

function createMockController(): MockController {
  const progressListeners = new Set<(progress: EmbeddingRuntimeBackfillProgress) => void>();
  const enqueueBackfillMock = vi.fn(async (_embeddingSetId: string) => {});

  return {
    controller: {
      enqueueBackfill: enqueueBackfillMock,
      ensureStarted: vi.fn(async () => createRuntimeStatus('running')),
      getStatus: vi.fn(async () => createRuntimeStatus('stopped')),
      onBackfillProgress: (callback) => {
        progressListeners.add(callback);
        return () => {
          progressListeners.delete(callback);
        };
      },
      onStatus: () => () => {},
      reset: vi.fn(async () => createRuntimeStatus('running')),
      start: vi.fn(async () => createRuntimeStatus('running')),
      stop: vi.fn(async () => createRuntimeStatus('stopped')),
    },
    emitBackfillProgress: (progress) => {
      for (const listener of progressListeners) {
        listener(progress);
      }
    },
    enqueueBackfillMock,
  };
}

function resetLiveQueryData(): void {
  liveQueryState.queueCounts.rows = [{ queued: 0, running: 0, failed: 0, succeeded: 0 }];
  liveQueryState.throughput.rows = [{ count: 0 }];
  liveQueryState.lastError.rows = [];
  liveQueryState.latency.rows = [];
  liveQueryState.coverage.rows = [];
}

describe('useVectorQueueState', () => {
  afterEach(() => {
    resetLiveQueryData();
    liveQueryRefresh.queueCounts.mockReset();
    liveQueryRefresh.throughput.mockReset();
    liveQueryRefresh.lastError.mockReset();
    liveQueryRefresh.latency.mockReset();
    liveQueryRefresh.coverage.mockReset();
    resetMockQueueMetrics();
    vectorStatusUiStoreState.durableQueueStats = null;
    vectorStatusUiStoreState.setIsJobQueueActive.mockReset();
    const testWindow = window as Window & {
      electronAPI?: unknown;
      embeddingHost?: unknown;
    };
    Object.defineProperty(testWindow, 'electronAPI', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(testWindow, 'embeddingHost', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it('reads queue and coverage state from live queries', () => {
    liveQueryState.queueCounts.rows = [{ queued: 3, running: 1, failed: 2, succeeded: 9 }];
    liveQueryState.throughput.rows = [{ count: 14 }];
    liveQueryState.lastError.rows = [{ error: 'embedding failed' }];
    liveQueryState.latency.rows = [
      { runAt: '2026-03-08T00:00:00.000Z', updatedAt: '2026-03-08T00:00:00.100Z' },
      { runAt: '2026-03-08T00:00:01.000Z', updatedAt: '2026-03-08T00:00:01.300Z' },
    ];
    liveQueryState.coverage.rows = [{ totalChunks: 12, chunksWithEmbeddingsForSet: 7 }];
    patchMockQueueMetrics({ throughputPerMinute: 999, windowErrorCount: 4, latencyP95Ms: 25 });

    const { result } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: createMockController().controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    expect(result.current.queueCounts).toEqual({
      queued: 3,
      running: 1,
      failed: 2,
      succeeded: 9,
    });
    expect(result.current.throughput).toBe(14);
    expect(result.current.lastError).toBe('embedding failed');
    expect(result.current.coverage).toEqual({ total: 12, withSet: 7 });
    expect(result.current.latencyStats.avgMs).toBeGreaterThan(0);
    expect(result.current.recentErrorCount).toBe(4);
    expect(result.current.telemetryTrend).toHaveLength(1);
  });

  it('uses the controller for backfill progress and clears queue-active state afterwards', async () => {
    const controller = createMockController();
    controller.enqueueBackfillMock.mockImplementationOnce(async (embeddingSetId: string) => {
      controller.emitBackfillProgress({
        embeddingSetId,
        requestId: 'embedding-backfill:test',
        stage: 'backfill',
        current: 2,
        total: 5,
      });
      controller.emitBackfillProgress({
        embeddingSetId,
        requestId: 'embedding-backfill:test',
        stage: 'backfill',
        current: 5,
        total: 5,
      });
    });

    const { result } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      await result.current.backfillActiveSet();
    });

    expect(controller.enqueueBackfillMock).toHaveBeenCalledWith('set-1');
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenNthCalledWith(1, true);
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenLastCalledWith(false);

    await waitFor(() => {
      expect(result.current.backfillProgress).toEqual({ done: 5, total: 5 });
    });
  });

  it('clears transient backfill state when controller backfill fails', async () => {
    const controller = createMockController();
    controller.enqueueBackfillMock.mockRejectedValueOnce(
      new Error("Backfill timed out while waiting for embedding set 'set-1' to drain.")
    );

    const { result } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      await expect(result.current.backfillActiveSet()).rejects.toThrow(
        "Backfill timed out while waiting for embedding set 'set-1' to drain."
      );
    });

    expect(result.current.backfilling).toBe(false);
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenNthCalledWith(1, true);
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenLastCalledWith(false);
  });

  it('refreshes live queries when the queue drained event targets the active embedding set', async () => {
    renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: createMockController().controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('brainstrike:queue-drained', {
          detail: { embeddingSetId: 'set-1', queue: 'embeddings' },
        })
      );
    });

    await waitFor(() => {
      expect(liveQueryRefresh.queueCounts).toHaveBeenCalledTimes(1);
    });
    expect(liveQueryRefresh.throughput).toHaveBeenCalledTimes(1);
    expect(liveQueryRefresh.lastError).toHaveBeenCalledTimes(1);
    expect(liveQueryRefresh.latency).toHaveBeenCalledTimes(1);
    expect(liveQueryRefresh.coverage).toHaveBeenCalledTimes(1);
  });

  it('ignores queue drained events for a different embedding set', async () => {
    renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: createMockController().controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('brainstrike:queue-drained', {
          detail: { embeddingSetId: 'set-2', queue: 'embeddings' },
        })
      );
    });

    expect(liveQueryRefresh.queueCounts).not.toHaveBeenCalled();
    expect(liveQueryRefresh.coverage).not.toHaveBeenCalled();
  });

  it('delegates API key validation to the queue service for the active set', async () => {
    const validateApiKeyForSet = vi.fn(async () => ({
      valid: false as const,
      message: 'Missing API key',
    }));
    const service = createMockService({ validateApiKeyForSet });

    const { result } = renderHook(() =>
      useVectorQueueState({
        service,
        controller: createMockController().controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await expect(result.current.validateApiKey()).resolves.toEqual({
      valid: false,
      message: 'Missing API key',
    });
    expect(validateApiKeyForSet).toHaveBeenCalledWith('set-1');
  });
});
