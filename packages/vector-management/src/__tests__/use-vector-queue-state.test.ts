import type { UsePGliteLiveQueryOptions } from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
import type { ElectronAPI } from '@brainstrike/types';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
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
  activeBackfill: null as null | {
    embeddingSetId: string;
    progress: { done: number; total: number } | null;
    requestId: string;
  },
  durableQueueStats: null as null | {
    failed: number;
    nextRunnableAt: string | null;
    queued: number;
    running: number;
    succeeded: number;
  },
  isJobQueueActive: false,
  setActiveBackfill: vi.fn(
    (
      backfill: null | {
        embeddingSetId: string;
        progress: { done: number; total: number } | null;
        requestId: string;
      }
    ) => {
      vectorStatusUiStoreState.activeBackfill = backfill;
    }
  ),
  setIsJobQueueActive: vi.fn((active: boolean) => {
    vectorStatusUiStoreState.isJobQueueActive = active;
  }),
};

interface LiveQueryShape {
  rows: unknown[];
}

const liveQueryRefresh = {
  activeSetQueueCounts: vi.fn(async () => {}),
  queueCounts: vi.fn(async () => {}),
  throughput: vi.fn(async () => {}),
  lastError: vi.fn(async () => {}),
  latency: vi.fn(async () => {}),
  coverage: vi.fn(async () => {}),
};

const liveQueryState: Record<
  'activeSetQueueCounts' | 'queueCounts' | 'throughput' | 'lastError' | 'latency' | 'coverage',
  LiveQueryShape
> = {
  activeSetQueueCounts: {
    rows: [{ queued: 0, running: 0, failed: 0, succeeded: 0 }],
  },
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
    usePGliteLiveQuery: vi.fn((options: UsePGliteLiveQueryOptions<unknown>) => {
      if (!options.enabled) {
        return { rows: [], loading: false, error: null, refresh: vi.fn(async () => {}) };
      }
      const query = options.query;
      if (query.includes('chunksWithEmbeddingsForSet')) {
        return {
          rows: liveQueryState.coverage.rows,
          loading: false,
          error: null,
          refresh: liveQueryRefresh.coverage,
        };
      }
      if (query.includes('embedding_set_id')) {
        return {
          rows: liveQueryState.activeSetQueueCounts.rows,
          loading: false,
          error: null,
          refresh: liveQueryRefresh.activeSetQueueCounts,
        };
      }
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
      return { rows: [], loading: false, error: null, refresh: vi.fn(async () => {}) };
    }),
  };
});

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', () => {
  const useVectorStatusUIStore = vi.fn(
    (selector: (state: typeof vectorStatusUiStoreState) => unknown) =>
      selector(vectorStatusUiStoreState)
  ) as unknown as {
    (selector: (state: typeof vectorStatusUiStoreState) => unknown): unknown;
    getState: () => typeof vectorStatusUiStoreState;
  };
  useVectorStatusUIStore.getState = () => vectorStatusUiStoreState;
  return { useVectorStatusUIStore };
});

interface MockController {
  readonly cancelAllBackfillsMock: ReturnType<typeof vi.fn>;
  readonly cancelBackfillMock: ReturnType<typeof vi.fn>;
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
  const cancelBackfillMock = vi.fn(async () => {});
  const cancelAllBackfillsMock = vi.fn(async () => {});
  const enqueueBackfillMock = vi.fn(async (_embeddingSetId: string) => ({
    requestId: 'embedding-backfill:test',
  }));

  return {
    cancelBackfillMock,
    cancelAllBackfillsMock,
    controller: {
      cancelBackfill: cancelBackfillMock,
      cancelAllBackfills: cancelAllBackfillsMock,
      enqueueBackfill: enqueueBackfillMock,
      ensureStarted: vi.fn(async () => createRuntimeStatus('running')),
      getBackfillsInFlight: vi.fn(async () => []),
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

function createDeferred(): {
  promise: Promise<void>;
  reject: (reason?: unknown) => void;
  resolve: () => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function createDesktopElectronApiStub(): ElectronAPI {
  return {
    fileSystem: {} as ElectronAPI['fileSystem'],
    loadLayout: async () => ({ success: true }),
    saveLayout: async () => ({ success: true }),
    storage: {} as ElectronAPI['storage'],
  };
}

function resetLiveQueryData(): void {
  liveQueryState.activeSetQueueCounts.rows = [{ queued: 0, running: 0, failed: 0, succeeded: 0 }];
  liveQueryState.queueCounts.rows = [{ queued: 0, running: 0, failed: 0, succeeded: 0 }];
  liveQueryState.throughput.rows = [{ count: 0 }];
  liveQueryState.lastError.rows = [];
  liveQueryState.latency.rows = [];
  liveQueryState.coverage.rows = [];
}

describe('useVectorQueueState', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetLiveQueryData();
    liveQueryRefresh.activeSetQueueCounts.mockReset();
    liveQueryRefresh.queueCounts.mockReset();
    liveQueryRefresh.throughput.mockReset();
    liveQueryRefresh.lastError.mockReset();
    liveQueryRefresh.latency.mockReset();
    liveQueryRefresh.coverage.mockReset();
    resetMockQueueMetrics();
    vectorStatusUiStoreState.activeBackfill = null;
    vectorStatusUiStoreState.durableQueueStats = null;
    vectorStatusUiStoreState.isJobQueueActive = false;
    vectorStatusUiStoreState.setActiveBackfill.mockReset();
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
    liveQueryState.activeSetQueueCounts.rows = [{ queued: 1, running: 2, failed: 0, succeeded: 3 }];
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
    expect(result.current.activeSetQueueCounts).toEqual({
      queued: 1,
      running: 2,
      failed: 0,
      succeeded: 3,
    });
    expect(result.current.throughput).toBe(14);
    expect(result.current.lastError).toBe('embedding failed');
    expect(result.current.coverage).toEqual({ total: 12, withSet: 7 });
    expect(result.current.latencyStats.avgMs).toBeGreaterThan(0);
    expect(result.current.recentErrorCount).toBe(4);
    expect(result.current.telemetryTrend).toHaveLength(1);
  });

  it('falls back to durable queue stats when live query rows are unavailable', () => {
    liveQueryState.queueCounts.rows = [];
    vectorStatusUiStoreState.durableQueueStats = {
      queued: 8,
      running: 1,
      failed: 2,
      succeeded: 34,
      nextRunnableAt: null,
    };

    const { result } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: createMockController().controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    expect(result.current.queueCounts).toEqual({
      queued: 8,
      running: 1,
      failed: 2,
      succeeded: 34,
    });
  });

  it('returns safe defaults and no-op queue actions without a service or active set', async () => {
    const controller = createMockController();
    const { result } = renderHook(() =>
      useVectorQueueState({
        service: null,
        controller: controller.controller,
        activeEmbeddingSetId: null,
        shouldAutoBackfill: false,
      })
    );

    expect(result.current.coverage).toEqual({ total: 0, withSet: 0 });
    await expect(result.current.validateApiKey()).resolves.toEqual({ valid: true });
    await expect(result.current.retryFailed()).resolves.toBeUndefined();
    await expect(result.current.clearQueue()).resolves.toBeUndefined();
    await expect(result.current.wipeQueue()).resolves.toBeUndefined();
    await expect(result.current.backfillActiveSet()).rejects.toThrow('No active embedding set');
    expect(controller.cancelAllBackfillsMock).not.toHaveBeenCalled();
  });

  it('refreshes live queries when live query polling is re-enabled', async () => {
    const controller = createMockController();
    const service = createMockService();
    const { rerender } = renderHook(
      (isImporting: boolean) =>
        useVectorQueueState({
          service,
          controller: controller.controller,
          activeEmbeddingSetId: 'set-1',
          shouldAutoBackfill: false,
          isImporting,
        }),
      { initialProps: true }
    );

    expect(liveQueryRefresh.queueCounts).not.toHaveBeenCalled();

    rerender(false);

    await waitFor(() => {
      expect(liveQueryRefresh.queueCounts).toHaveBeenCalledTimes(1);
    });
    expect(liveQueryRefresh.activeSetQueueCounts).toHaveBeenCalledTimes(1);
    expect(liveQueryRefresh.coverage).toHaveBeenCalledTimes(1);
  });

  it('uses incremental live queries only for stable keyed queue detail rows', () => {
    renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: createMockController().controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    const liveQueryCalls = vi.mocked(usePGliteLiveQuery).mock.calls.map(([options]) => options);
    const queueCountsCall = liveQueryCalls.find((options) =>
      options.query.includes("FILTER (WHERE state = 'queued'")
    );
    const lastErrorCall = liveQueryCalls.find(
      (options) =>
        options.query.includes('ORDER BY updated_at DESC') && options.query.includes('LIMIT 1')
    );
    const activeSetQueueCountsCall = liveQueryCalls.find((options) =>
      options.query.includes('embedding_set_id')
    );
    const throughputCall = liveQueryCalls.find((options) =>
      options.query.includes("INTERVAL '60 seconds'")
    );
    const latencyCall = liveQueryCalls.find((options) =>
      options.query.includes("INTERVAL '5 minutes'")
    );
    const coverageCall = liveQueryCalls.find((options) =>
      options.query.includes('chunksWithEmbeddingsForSet')
    );

    expect(queueCountsCall).not.toHaveProperty('mode', 'incremental');
    expect(lastErrorCall).not.toHaveProperty('mode', 'incremental');
    expect(activeSetQueueCountsCall).not.toHaveProperty('mode', 'incremental');
    expect(throughputCall).not.toHaveProperty('mode', 'incremental');
    expect(latencyCall).toEqual(expect.objectContaining({ mode: 'incremental', key: 'id' }));
    expect(coverageCall).not.toHaveProperty('mode', 'incremental');
  });

  it('uses the controller for backfill progress and clears queue-active state afterwards', async () => {
    const controller = createMockController();
    controller.enqueueBackfillMock.mockImplementationOnce(async (embeddingSetId: string) => {
      controller.emitBackfillProgress({
        embeddingSetId,
        requestId: 'embedding-backfill:test',
        source: 'manual',
        stage: 'backfill',
        current: 2,
        total: 5,
      });
      controller.emitBackfillProgress({
        embeddingSetId,
        requestId: 'embedding-backfill:test',
        source: 'manual',
        stage: 'backfill',
        current: 5,
        total: 5,
      });
    });

    const { result, rerender } = renderHook(() =>
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

    expect(controller.enqueueBackfillMock).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        source: 'manual',
      })
    );
    expect(vectorStatusUiStoreState.setActiveBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingSetId: 'set-1',
        progress: null,
      })
    );
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenNthCalledWith(1, true);
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenLastCalledWith(false);

    rerender();
    expect(result.current.backfillProgress).toEqual({ done: 5, total: 5 });
  });

  it('ignores backfill progress for other embedding sets', async () => {
    const controller = createMockController();
    controller.enqueueBackfillMock.mockImplementationOnce(async (embeddingSetId: string) => {
      controller.emitBackfillProgress({
        embeddingSetId: 'set-2',
        requestId: 'embedding-backfill:other',
        source: 'manual',
        stage: 'backfill',
        current: 9,
        total: 10,
      });
      controller.emitBackfillProgress({
        embeddingSetId,
        requestId: 'embedding-backfill:active',
        source: 'manual',
        stage: 'backfill',
        current: 1,
        total: 10,
      });
    });

    const { result, rerender } = renderHook(() =>
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

    rerender();
    expect(result.current.backfillProgress).toEqual({ done: 1, total: 10 });
  });

  it('preserves backfill progress across remounts by reading the shared store', async () => {
    const controller = createMockController();
    controller.enqueueBackfillMock.mockImplementationOnce(async (embeddingSetId: string) => {
      controller.emitBackfillProgress({
        embeddingSetId,
        requestId: 'embedding-backfill:shared',
        source: 'manual',
        stage: 'backfill',
        current: 3,
        total: 10,
      });
    });

    const firstRender = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      await firstRender.result.current.backfillActiveSet();
    });

    firstRender.unmount();

    const secondRender = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    expect(secondRender.result.current.backfilling).toBe(true);
    expect(secondRender.result.current.backfillProgress).toEqual({ done: 3, total: 10 });
    expect(secondRender.result.current.activeSetBackfilling).toBe(true);
    expect(secondRender.result.current.activeSetBackfillProgress).toEqual({ done: 3, total: 10 });
  });

  it('keeps backfill progress visible even when the active collection changes mid-backfill', () => {
    vectorStatusUiStoreState.activeBackfill = {
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:shared',
      progress: { done: 7, total: 10 },
    };

    const { result } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: createMockController().controller,
        activeEmbeddingSetId: 'set-2',
        shouldAutoBackfill: false,
      })
    );

    expect(result.current.backfilling).toBe(true);
    expect(result.current.backfillProgress).toEqual({ done: 7, total: 10 });
    expect(result.current.activeSetBackfilling).toBe(false);
    expect(result.current.activeSetBackfillProgress).toBeNull();
  });

  it('clears stale active-set backfill state when the desktop host reports no in-flight backfills', async () => {
    window.electronAPI = createDesktopElectronApiStub();
    vectorStatusUiStoreState.activeBackfill = {
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:stale',
      progress: { done: 7, total: 10 },
    };
    vectorStatusUiStoreState.isJobQueueActive = true;

    const controller = createMockController();
    vi.mocked(controller.controller.getBackfillsInFlight).mockResolvedValueOnce([]);

    renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await waitFor(() => {
      expect(vectorStatusUiStoreState.activeBackfill).toBeNull();
    });
    expect(vectorStatusUiStoreState.isJobQueueActive).toBe(false);
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenCalledWith(false);
  });

  it('does not clear another collection backfill while reconciling the active set after reload', async () => {
    window.electronAPI = createDesktopElectronApiStub();
    vectorStatusUiStoreState.activeBackfill = {
      embeddingSetId: 'set-2',
      requestId: 'embedding-backfill:other-set',
      progress: { done: 4, total: 10 },
    };
    vectorStatusUiStoreState.isJobQueueActive = true;

    const controller = createMockController();
    vi.mocked(controller.controller.getBackfillsInFlight).mockResolvedValueOnce([]);

    renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await waitFor(() => {
      expect(controller.controller.getBackfillsInFlight).toHaveBeenCalledTimes(1);
    });
    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-2',
      requestId: 'embedding-backfill:other-set',
      progress: { done: 4, total: 10 },
    });
    expect(vectorStatusUiStoreState.isJobQueueActive).toBe(true);
  });

  it('restores an in-flight desktop backfill after reload and cleans up the recovery listener', async () => {
    window.electronAPI = createDesktopElectronApiStub();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_781_020_800_000);

    const controller = createMockController();
    vi.mocked(controller.controller.getBackfillsInFlight).mockResolvedValueOnce([
      {
        embeddingSetId: 'set-1',
        progress: null,
        requestId: 'embedding-backfill:restored',
        source: 'manual',
      },
    ]);

    const { unmount } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await waitFor(() => {
      expect(vectorStatusUiStoreState.activeBackfill).toEqual({
        embeddingSetId: 'set-1',
        requestId: 'recovered:set-1:1781020800000',
        progress: null,
      });
    });
    expect(vectorStatusUiStoreState.isJobQueueActive).toBe(true);

    controller.emitBackfillProgress({
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:restored',
      source: 'manual',
      stage: 'backfill',
      current: 3,
      total: 9,
    });

    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:restored',
      progress: { done: 3, total: 9 },
    });

    unmount();
    controller.emitBackfillProgress({
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:after-unmount',
      source: 'manual',
      stage: 'backfill',
      current: 4,
      total: 9,
    });
    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:restored',
      progress: { done: 3, total: 9 },
    });
    nowSpy.mockRestore();
  });

  it('does not overwrite an existing real backfill while restoring desktop state', async () => {
    window.electronAPI = createDesktopElectronApiStub();
    vectorStatusUiStoreState.activeBackfill = {
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:real',
      progress: { done: 2, total: 10 },
    };

    const controller = createMockController();
    vi.mocked(controller.controller.getBackfillsInFlight).mockResolvedValueOnce([
      {
        embeddingSetId: 'set-1',
        progress: null,
        requestId: 'embedding-backfill:host',
        source: 'manual',
      },
    ]);

    renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await waitFor(() => {
      expect(controller.controller.getBackfillsInFlight).toHaveBeenCalledTimes(1);
    });
    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:real',
      progress: { done: 2, total: 10 },
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

  it('logs canceled backfills as cancellation instead of failure noise', async () => {
    const controller = createMockController();
    const cancellation = new Error('Abort copy can change without changing semantics.');
    cancellation.name = 'AbortError';
    controller.enqueueBackfillMock.mockRejectedValueOnce(cancellation);
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    const { result } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    try {
      await act(async () => {
        await expect(result.current.backfillActiveSet()).rejects.toMatchObject({
          message: 'Abort copy can change without changing semantics.',
          name: 'AbortError',
        });
      });
    } finally {
      unsubscribe();
    }

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: LogLevel.INFO,
          message: 'backfillActiveSet: backfill canceled',
        }),
      ])
    );
    expect(records).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: LogLevel.ERROR,
          message: 'backfillActiveSet: backfill failed',
        }),
      ])
    );
  });

  it('treats a desktop { canceled: true } enqueue result as cancellation, not completion', async () => {
    const controller = createMockController();
    // Desktop main resolves { canceled: true } (instead of rejecting) for a
    // deliberate cancellation. The hook must re-raise it as an abort and log it
    // as canceled — never dispatch queue-drained or log "completed".
    controller.enqueueBackfillMock.mockResolvedValueOnce({ canceled: true });
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    const { result } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    try {
      await act(async () => {
        await expect(result.current.backfillActiveSet()).rejects.toMatchObject({
          name: 'AbortError',
        });
      });
    } finally {
      unsubscribe();
    }

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: LogLevel.INFO,
          message: 'backfillActiveSet: backfill canceled',
        }),
      ])
    );
    expect(records).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: LogLevel.INFO,
          message: 'backfillActiveSet: backfill completed',
        }),
      ])
    );
  });

  it('does not let an older backfill invocation clear newer backfill state', async () => {
    vi.useFakeTimers();
    const controller = createMockController();
    const firstBackfill = createDeferred();
    const secondBackfill = createDeferred();

    controller.enqueueBackfillMock
      .mockImplementationOnce(async () => await firstBackfill.promise)
      .mockImplementationOnce(async () => await secondBackfill.promise);

    const { result } = renderHook(() =>
      useVectorQueueState({
        service: createMockService(),
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    const firstRun = result.current.backfillActiveSet();
    controller.emitBackfillProgress({
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:first',
      source: 'manual',
      stage: 'backfill',
      current: 1,
      total: 10,
    });

    const secondRun = result.current.backfillActiveSet();
    controller.emitBackfillProgress({
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:second',
      source: 'manual',
      stage: 'backfill',
      current: 4,
      total: 10,
    });

    firstBackfill.resolve();
    await act(async () => {
      await firstRun;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:second',
      progress: { done: 4, total: 10 },
    });
    expect(vectorStatusUiStoreState.setIsJobQueueActive).not.toHaveBeenCalledWith(false);

    secondBackfill.resolve();
    await act(async () => {
      await secondRun;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(vectorStatusUiStoreState.activeBackfill).toBeNull();
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenLastCalledWith(false);
    vi.useRealTimers();
  });

  it('clears transient backfill UI state when the queue is wiped', async () => {
    const callOrder: string[] = [];
    const service = createMockService({
      wipeQueue: vi.fn(async () => {
        callOrder.push('wipe');
      }),
    });
    const controller = createMockController();
    controller.cancelAllBackfillsMock.mockImplementation(async () => {
      callOrder.push('cancel');
    });
    vectorStatusUiStoreState.activeBackfill = {
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:wipe-me',
      progress: { done: 2, total: 10 },
    };
    vectorStatusUiStoreState.isJobQueueActive = true;

    const { result } = renderHook(() =>
      useVectorQueueState({
        service,
        controller: controller.controller,
        activeEmbeddingSetId: 'set-1',
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      await result.current.wipeQueue();
    });

    expect(controller.cancelAllBackfillsMock).toHaveBeenCalledTimes(1);
    expect(service.wipeQueue).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['cancel', 'wipe']);
    expect(vectorStatusUiStoreState.activeBackfill).toBeNull();
    expect(vectorStatusUiStoreState.isJobQueueActive).toBe(false);
    expect(vectorStatusUiStoreState.setIsJobQueueActive).toHaveBeenCalledWith(false);
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
    expect(liveQueryRefresh.activeSetQueueCounts).toHaveBeenCalledTimes(1);
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
    expect(liveQueryRefresh.activeSetQueueCounts).not.toHaveBeenCalled();
    expect(liveQueryRefresh.coverage).not.toHaveBeenCalled();
  });

  it('clears a lingering recovered backfill when the queue drains for the active set', async () => {
    // Regression: a background job populated a "recovered" backfill via the
    // desktop reconcile path. The recovery path only re-checks on remount, so a
    // job that drained while mounted left the recovered state stranded — which is
    // what kept the coverage banner spinning all night. The queue-drained signal
    // for this set must clear it.
    vectorStatusUiStoreState.activeBackfill = {
      embeddingSetId: 'set-1',
      requestId: 'recovered:set-1:1700000000000',
      progress: { done: 10, total: 10 },
    };
    vectorStatusUiStoreState.isJobQueueActive = true;

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
      expect(vectorStatusUiStoreState.activeBackfill).toBeNull();
    });
  });

  it('does not clear a real (non-recovered) backfill when the queue drains', async () => {
    // A genuine in-flight backfill is owned by its own completion path; a
    // queue-drained event (possibly between batches) must not wipe it.
    vectorStatusUiStoreState.activeBackfill = {
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:real',
      progress: { done: 5, total: 10 },
    };

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

    expect(vectorStatusUiStoreState.activeBackfill).not.toBeNull();
  });

  it('delegates API key validation to the queue service for the active set', async () => {
    const validateApiKeyForSet = vi.fn(async () => ({
      valid: false as const,
      reason: 'missing-provider-key' as const,
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
      reason: 'missing-provider-key',
      message: 'Missing API key',
    });
    expect(validateApiKeyForSet).toHaveBeenCalledWith('set-1');
  });
});
