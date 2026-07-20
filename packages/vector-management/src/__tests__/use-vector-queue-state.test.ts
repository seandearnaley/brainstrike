import type { UsePGliteLiveQueryOptions } from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
import type { ElectronAPI } from '@brainstrike/types';
import { QUEUE_DRAINED_EVENT } from '@brainstrike/utils/browser-events';
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
  coverage: vi.fn(async () => {}),
  lastError: vi.fn(async () => {}),
  latency: vi.fn(async () => {}),
  queueCounts: vi.fn(async () => {}),
  throughput: vi.fn(async () => {}),
};

const liveQueryState: Record<
  'activeSetQueueCounts' | 'queueCounts' | 'throughput' | 'lastError' | 'latency' | 'coverage',
  LiveQueryShape
> = {
  activeSetQueueCounts: {
    rows: [{ failed: 0, queued: 0, running: 0, succeeded: 0 }],
  },
  coverage: {
    rows: [],
  },
  lastError: {
    rows: [],
  },
  latency: {
    rows: [],
  },
  queueCounts: {
    rows: [{ failed: 0, queued: 0, running: 0, succeeded: 0 }],
  },
  throughput: {
    rows: [{ count: 0 }],
  },
};

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    usePGliteLiveQuery: vi.fn((options: UsePGliteLiveQueryOptions<unknown>) => {
      if (!options.enabled) {
        return { error: null, loading: false, refresh: vi.fn(async () => {}), rows: [] };
      }
      const query = options.query;
      if (query.includes('chunksWithEmbeddingsForSet')) {
        return {
          error: null,
          loading: false,
          refresh: liveQueryRefresh.coverage,
          rows: liveQueryState.coverage.rows,
        };
      }
      if (query.includes('embedding_set_id')) {
        return {
          error: null,
          loading: false,
          refresh: liveQueryRefresh.activeSetQueueCounts,
          rows: liveQueryState.activeSetQueueCounts.rows,
        };
      }
      if (query.includes("FILTER (WHERE state = 'queued'")) {
        return {
          error: null,
          loading: false,
          refresh: liveQueryRefresh.queueCounts,
          rows: liveQueryState.queueCounts.rows,
        };
      }
      if (query.includes("INTERVAL '60 seconds'")) {
        return {
          error: null,
          loading: false,
          refresh: liveQueryRefresh.throughput,
          rows: liveQueryState.throughput.rows,
        };
      }
      if (query.includes("state = 'failed'")) {
        return {
          error: null,
          loading: false,
          refresh: liveQueryRefresh.lastError,
          rows: liveQueryState.lastError.rows,
        };
      }
      if (query.includes("INTERVAL '5 minutes'")) {
        return {
          error: null,
          loading: false,
          refresh: liveQueryRefresh.latency,
          rows: liveQueryState.latency.rows,
        };
      }
      return { error: null, loading: false, refresh: vi.fn(async () => {}), rows: [] };
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
    active: false,
    lastError: null,
    runtimeId: 'embedding-worker:test',
    runtimeKind: 'embedding-worker',
    state,
  };
}

function createMockService(overrides: Partial<VectorQueueService> = {}): VectorQueueService {
  return {
    backfill: vi.fn(async () => ({ failed: 0, queued: 0, running: 0, succeeded: 0 })),
    clearQueue: vi.fn(async () => {}),
    reembedSet: vi.fn(async () => ({
      clearedCount: 0,
      queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
    })),
    refresh: vi.fn(async () => ({
      coverage: null,
      lastError: null,
      latency: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
      queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
      throughput: 0,
    })),
    retryFailed: vi.fn(async () => {}),
    validateApiKeyForSet: vi.fn(async () => ({ valid: true as const })),
    wipeQueue: vi.fn(async () => {}),
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
    cancelAllBackfillsMock,
    cancelBackfillMock,
    controller: {
      cancelAllBackfills: cancelAllBackfillsMock,
      cancelBackfill: cancelBackfillMock,
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
  liveQueryState.activeSetQueueCounts.rows = [{ failed: 0, queued: 0, running: 0, succeeded: 0 }];
  liveQueryState.queueCounts.rows = [{ failed: 0, queued: 0, running: 0, succeeded: 0 }];
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
      value: undefined,
      writable: true,
    });
    Object.defineProperty(testWindow, 'embeddingHost', {
      configurable: true,
      value: undefined,
      writable: true,
    });
  });

  it('reads queue and coverage state from live queries', () => {
    liveQueryState.activeSetQueueCounts.rows = [{ failed: 0, queued: 1, running: 2, succeeded: 3 }];
    liveQueryState.queueCounts.rows = [{ failed: 2, queued: 3, running: 1, succeeded: 9 }];
    liveQueryState.throughput.rows = [{ count: 14 }];
    liveQueryState.lastError.rows = [{ error: 'embedding failed' }];
    liveQueryState.latency.rows = [
      { runAt: '2026-03-08T00:00:00.000Z', updatedAt: '2026-03-08T00:00:00.100Z' },
      { runAt: '2026-03-08T00:00:01.000Z', updatedAt: '2026-03-08T00:00:01.300Z' },
    ];
    liveQueryState.coverage.rows = [{ chunksWithEmbeddingsForSet: 7, totalChunks: 12 }];
    patchMockQueueMetrics({ latencyP95Ms: 25, throughputPerMinute: 999, windowErrorCount: 4 });

    const { result } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: createMockController().controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    expect(result.current.queueCounts).toEqual({
      failed: 2,
      queued: 3,
      running: 1,
      succeeded: 9,
    });
    expect(result.current.activeSetQueueCounts).toEqual({
      failed: 0,
      queued: 1,
      running: 2,
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
      failed: 2,
      nextRunnableAt: null,
      queued: 8,
      running: 1,
      succeeded: 34,
    };

    const { result } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: createMockController().controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    expect(result.current.queueCounts).toEqual({
      failed: 2,
      queued: 8,
      running: 1,
      succeeded: 34,
    });
  });

  it('returns safe defaults and no-op queue actions without a service or active set', async () => {
    const controller = createMockController();
    const { result } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: null,
        controller: controller.controller,
        service: null,
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
          activeEmbeddingSetId: 'set-1',
          controller: controller.controller,
          isImporting,
          service,
          shouldAutoBackfill: false,
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
        activeEmbeddingSetId: 'set-1',
        controller: createMockController().controller,
        service: createMockService(),
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
    expect(latencyCall).toEqual(expect.objectContaining({ key: 'id', mode: 'incremental' }));
    expect(coverageCall).not.toHaveProperty('mode', 'incremental');
  });

  it('uses the controller for backfill progress and clears queue-active state afterwards', async () => {
    const controller = createMockController();
    controller.enqueueBackfillMock.mockImplementationOnce(async (embeddingSetId: string) => {
      controller.emitBackfillProgress({
        current: 2,
        embeddingSetId,
        requestId: 'embedding-backfill:test',
        source: 'manual',
        stage: 'backfill',
        total: 5,
      });
      controller.emitBackfillProgress({
        current: 5,
        embeddingSetId,
        requestId: 'embedding-backfill:test',
        source: 'manual',
        stage: 'backfill',
        total: 5,
      });
    });

    const { result, rerender } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
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
        current: 9,
        embeddingSetId: 'set-2',
        requestId: 'embedding-backfill:other',
        source: 'manual',
        stage: 'backfill',
        total: 10,
      });
      controller.emitBackfillProgress({
        current: 1,
        embeddingSetId,
        requestId: 'embedding-backfill:active',
        source: 'manual',
        stage: 'backfill',
        total: 10,
      });
    });

    const { result, rerender } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
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
        current: 3,
        embeddingSetId,
        requestId: 'embedding-backfill:shared',
        source: 'manual',
        stage: 'backfill',
        total: 10,
      });
    });

    const firstRender = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      await firstRender.result.current.backfillActiveSet();
    });

    firstRender.unmount();

    const secondRender = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
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
      progress: { done: 7, total: 10 },
      requestId: 'embedding-backfill:shared',
    };

    const { result } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-2',
        controller: createMockController().controller,
        service: createMockService(),
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
      progress: { done: 7, total: 10 },
      requestId: 'embedding-backfill:stale',
    };
    vectorStatusUiStoreState.isJobQueueActive = true;

    const controller = createMockController();
    vi.mocked(controller.controller.getBackfillsInFlight).mockResolvedValueOnce([]);

    renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
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
      progress: { done: 4, total: 10 },
      requestId: 'embedding-backfill:other-set',
    };
    vectorStatusUiStoreState.isJobQueueActive = true;

    const controller = createMockController();
    vi.mocked(controller.controller.getBackfillsInFlight).mockResolvedValueOnce([]);

    renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    await waitFor(() => {
      expect(controller.controller.getBackfillsInFlight).toHaveBeenCalledTimes(1);
    });
    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-2',
      progress: { done: 4, total: 10 },
      requestId: 'embedding-backfill:other-set',
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
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    await waitFor(() => {
      expect(vectorStatusUiStoreState.activeBackfill).toEqual({
        embeddingSetId: 'set-1',
        progress: null,
        requestId: 'recovered:set-1:1781020800000',
      });
    });
    expect(vectorStatusUiStoreState.isJobQueueActive).toBe(true);

    controller.emitBackfillProgress({
      current: 3,
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:restored',
      source: 'manual',
      stage: 'backfill',
      total: 9,
    });

    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-1',
      progress: { done: 3, total: 9 },
      requestId: 'embedding-backfill:restored',
    });

    unmount();
    controller.emitBackfillProgress({
      current: 4,
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:after-unmount',
      source: 'manual',
      stage: 'backfill',
      total: 9,
    });
    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-1',
      progress: { done: 3, total: 9 },
      requestId: 'embedding-backfill:restored',
    });
    nowSpy.mockRestore();
  });

  it('does not overwrite an existing real backfill while restoring desktop state', async () => {
    window.electronAPI = createDesktopElectronApiStub();
    vectorStatusUiStoreState.activeBackfill = {
      embeddingSetId: 'set-1',
      progress: { done: 2, total: 10 },
      requestId: 'embedding-backfill:real',
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
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    await waitFor(() => {
      expect(controller.controller.getBackfillsInFlight).toHaveBeenCalledTimes(1);
    });
    expect(vectorStatusUiStoreState.activeBackfill).toEqual({
      embeddingSetId: 'set-1',
      progress: { done: 2, total: 10 },
      requestId: 'embedding-backfill:real',
    });
  });

  it('clears transient backfill state when controller backfill fails', async () => {
    const controller = createMockController();
    controller.enqueueBackfillMock.mockRejectedValueOnce(
      new Error("Backfill timed out while waiting for embedding set 'set-1' to drain.")
    );

    const { result } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
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
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
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
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
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
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    const firstRun = result.current.backfillActiveSet();
    controller.emitBackfillProgress({
      current: 1,
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:first',
      source: 'manual',
      stage: 'backfill',
      total: 10,
    });

    const secondRun = result.current.backfillActiveSet();
    controller.emitBackfillProgress({
      current: 4,
      embeddingSetId: 'set-1',
      requestId: 'embedding-backfill:second',
      source: 'manual',
      stage: 'backfill',
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
      progress: { done: 4, total: 10 },
      requestId: 'embedding-backfill:second',
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
      progress: { done: 2, total: 10 },
      requestId: 'embedding-backfill:wipe-me',
    };
    vectorStatusUiStoreState.isJobQueueActive = true;

    const { result } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: controller.controller,
        service,
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
        activeEmbeddingSetId: 'set-1',
        controller: createMockController().controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(QUEUE_DRAINED_EVENT, {
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
        activeEmbeddingSetId: 'set-1',
        controller: createMockController().controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(QUEUE_DRAINED_EVENT, {
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
      progress: { done: 10, total: 10 },
      requestId: 'recovered:set-1:1700000000000',
    };
    vectorStatusUiStoreState.isJobQueueActive = true;

    renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: createMockController().controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(QUEUE_DRAINED_EVENT, {
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
      progress: { done: 5, total: 10 },
      requestId: 'embedding-backfill:real',
    };

    renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: createMockController().controller,
        service: createMockService(),
        shouldAutoBackfill: false,
      })
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(QUEUE_DRAINED_EVENT, {
          detail: { embeddingSetId: 'set-1', queue: 'embeddings' },
        })
      );
    });

    expect(vectorStatusUiStoreState.activeBackfill).not.toBeNull();
  });

  it('delegates API key validation to the queue service for the active set', async () => {
    const validateApiKeyForSet = vi.fn(async () => ({
      message: 'Missing API key',
      reason: 'missing-provider-key' as const,
      valid: false as const,
    }));
    const service = createMockService({ validateApiKeyForSet });

    const { result } = renderHook(() =>
      useVectorQueueState({
        activeEmbeddingSetId: 'set-1',
        controller: createMockController().controller,
        service,
        shouldAutoBackfill: false,
      })
    );

    await expect(result.current.validateApiKey()).resolves.toEqual({
      message: 'Missing API key',
      reason: 'missing-provider-key',
      valid: false,
    });
    expect(validateApiKeyForSet).toHaveBeenCalledWith('set-1');
  });
});
