import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  __resetIndexingActivityStoreForTests,
  type IndexingDatabaseWorkPriorityStats,
  type IndexingDatabaseWorkSnapshot,
  useIndexingActivityStore,
} from '@brainstrike/preferences/stores/indexing-activity-store';
import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexingActivityCoordinator } from '../indexing-activity-coordinator';
import type {
  EmbeddingRuntimeBackfillProgress,
  EmbeddingRuntimeController,
  EmbeddingRuntimeStatus,
} from '../vector-status/embedding-runtime-controller';

const {
  databaseWorkSchedulerState,
  createPriorityDbHandleMock,
  getDatabaseWorkSchedulerMock,
  makeLiveQueryKeyMock,
  usePGliteDatabaseMock,
  usePGliteLiveQueryMock,
  useSharedEmbeddingRuntimeMock,
} = vi.hoisted(() => {
  const databaseWorkSchedulerState = {
    current: null as {
      getSnapshot: ReturnType<typeof vi.fn>;
      subscribe: ReturnType<typeof vi.fn>;
    } | null,
  };
  return {
    createPriorityDbHandleMock: vi.fn((db: unknown) => db),
    databaseWorkSchedulerState,
    getDatabaseWorkSchedulerMock: vi.fn(() => databaseWorkSchedulerState.current),
    makeLiveQueryKeyMock: vi.fn((...args: readonly unknown[]) => JSON.stringify(args)),
    usePGliteDatabaseMock: vi.fn((): unknown => null),
    usePGliteLiveQueryMock: vi.fn(),
    useSharedEmbeddingRuntimeMock: vi.fn(),
  };
});

interface LiveQueryState {
  error: Error | null;
  loading: boolean;
  rows: unknown[];
}

const liveQueryState: LiveQueryState = {
  error: null,
  loading: false,
  rows: [],
};

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: T) => void;
} {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return {
    promise,
    reject: rejectDeferred,
    resolve: resolveDeferred,
  };
}

function createPriorityStats(
  overrides: Partial<IndexingDatabaseWorkPriorityStats> = {}
): IndexingDatabaseWorkPriorityStats {
  return {
    completed: 0,
    lastCompletedLabel: null,
    lastStartedLabel: null,
    longestWaitMs: 0,
    queued: 0,
    serviceP50Ms: 0,
    serviceP95Ms: 0,
    started: 0,
    totalServiceMs: 0,
    totalWaitMs: 0,
    waitP50Ms: 0,
    waitP95Ms: 0,
    ...overrides,
  };
}

function createDatabaseWorkSnapshot(
  overrides: Partial<IndexingDatabaseWorkSnapshot> = {}
): IndexingDatabaseWorkSnapshot {
  return {
    backgroundWaiting: false,
    backgroundWaitingSince: null,
    backgroundYieldCount: 0,
    currentBackgroundWaitMs: 0,
    foregroundQuietMs: 75,
    lastBackgroundYieldAt: null,
    lastCompletedAt: null,
    lastForegroundAt: null,
    lastNormalAt: null,
    lastStartedAt: null,
    priorityStats: {
      background: createPriorityStats(),
      foreground: createPriorityStats(),
      normal: createPriorityStats(),
    },
    queued: { background: 0, foreground: 0, normal: 0 },
    queuedLabels: { background: [], foreground: [], normal: [] },
    runningLabel: null,
    runningPriority: null,
    snapshotAt: 0,
    ...overrides,
  };
}

vi.mock('@brainstrike/db', () => ({
  createPriorityDbHandle: createPriorityDbHandleMock,
  getDatabaseWorkScheduler: getDatabaseWorkSchedulerMock,
  makeLiveQueryKey: makeLiveQueryKeyMock,
  usePGliteDatabase: usePGliteDatabaseMock,
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

vi.mock('../embedding-runtime-provider', () => ({
  useSharedEmbeddingRuntime: useSharedEmbeddingRuntimeMock,
}));

function createRuntimeStatus(
  state: EmbeddingRuntimeStatus['state'],
  lastError: string | null = null
): EmbeddingRuntimeStatus {
  return {
    active: state === 'running',
    lastError,
    runtimeId: 'embedding-worker:test',
    runtimeKind: 'embedding-worker',
    state,
  };
}

function createMockRuntime(): {
  controller: EmbeddingRuntimeController;
  emitBackfillProgress: (progress: EmbeddingRuntimeBackfillProgress) => void;
  emitStatus: (status: EmbeddingRuntimeStatus) => void;
} {
  const backfillListeners = new Set<(progress: EmbeddingRuntimeBackfillProgress) => void>();
  const statusListeners = new Set<(status: EmbeddingRuntimeStatus) => void>();
  const controller: EmbeddingRuntimeController = {
    cancelAllBackfills: vi.fn(async () => {}),
    cancelBackfill: vi.fn(async () => {}),
    enqueueBackfill: vi.fn(async () => ({ requestId: 'embedding-backfill:test' })),
    ensureStarted: vi.fn(async () => createRuntimeStatus('running')),
    getBackfillsInFlight: vi.fn(async () => []),
    getStatus: vi.fn(async () => createRuntimeStatus('stopped')),
    onBackfillProgress: (callback) => {
      backfillListeners.add(callback);
      return () => {
        backfillListeners.delete(callback);
      };
    },
    onStatus: (callback) => {
      statusListeners.add(callback);
      return () => {
        statusListeners.delete(callback);
      };
    },
    reset: vi.fn(async () => createRuntimeStatus('running')),
    start: vi.fn(async () => createRuntimeStatus('running')),
    stop: vi.fn(async () => createRuntimeStatus('stopped')),
  };

  return {
    controller,
    emitBackfillProgress: (progress) => {
      for (const listener of backfillListeners) {
        listener(progress);
      }
    },
    emitStatus: (status) => {
      for (const listener of statusListeners) {
        listener(status);
      }
    },
  };
}

describe('IndexingActivityCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveQueryState.rows = [];
    liveQueryState.loading = false;
    liveQueryState.error = null;
    databaseWorkSchedulerState.current = null;
    usePGliteDatabaseMock.mockReturnValue(null);
    usePGliteLiveQueryMock.mockImplementation(() => ({
      error: liveQueryState.error,
      loading: liveQueryState.loading,
      refresh: vi.fn(async () => {}),
      rows: liveQueryState.rows,
    }));
    __resetIndexingActivityStoreForTests();
    __resetVectorStatusUIStoreForTests();
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
    useSharedEmbeddingRuntimeMock.mockReturnValue({
      controller: createMockRuntime().controller,
      service: null,
    });
  });

  it('samples queue state without subscribing live to the hot job_queue table', async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          failed: '0',
          nextRunnableAt: '2026-04-25T12:00:00.000Z',
          queued: '7',
          running: '1',
          succeeded: '23',
        },
      ],
    }));
    usePGliteDatabaseMock.mockReturnValue({ query });

    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
        phase: 'queue',
        queue: {
          failed: 0,
          nextRunnableAt: '2026-04-25T12:00:00.000Z',
          queued: 7,
          running: 1,
          succeeded: 23,
        },
        status: 'active',
      });
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM job_queue'), ['embeddings']);
    expect(createPriorityDbHandleMock).toHaveBeenCalledWith({ query }, 'background');
    expect(usePGliteLiveQueryMock).not.toHaveBeenCalled();
    expect(useVectorStatusUIStore.getState().durableQueueStats).toEqual({
      failed: 0,
      nextRunnableAt: '2026-04-25T12:00:00.000Z',
      queued: 7,
      running: 1,
      succeeded: 23,
    });
    expect(useVectorStatusUIStore.getState().isJobQueueActive).toBe(true);
  });

  it('keeps backfills visible across collections through runtime in-flight state', async () => {
    const runtime = createMockRuntime();
    vi.mocked(runtime.controller.getBackfillsInFlight).mockResolvedValue([
      {
        embeddingSetId: 'collection-b',
        progress: { current: 2, total: 9 },
        requestId: 'embedding-backfill:collection-b',
        source: 'manual',
      },
    ]);
    useSharedEmbeddingRuntimeMock.mockReturnValue({
      controller: runtime.controller,
      service: null,
    });

    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot.activeBackfills).toEqual([
        {
          current: 2,
          embeddingSetId: 'collection-b',
          requestId: 'embedding-backfill:collection-b',
          source: 'manual',
          total: 9,
        },
      ]);
    });

    runtime.emitBackfillProgress({
      current: 5,
      embeddingSetId: 'collection-c',
      requestId: 'background-indexing-backfill:collection-c',
      source: 'background-indexing',
      stage: 'backfill',
      total: 11,
    });

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot.activeBackfills).toEqual([
        {
          current: 5,
          embeddingSetId: 'collection-c',
          requestId: 'background-indexing-backfill:collection-c',
          source: 'background-indexing',
          total: 11,
        },
      ]);
    });
  });

  it('keeps unknown live query state unavailable instead of inventing idle zero counts', async () => {
    useBackgroundIndexingPreferencesStore.getState().setEnabled(false);

    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
        phase: null,
        queue: null,
        status: 'unavailable',
      });
    });
    expect(useVectorStatusUIStore.getState().durableQueueStats).toBeNull();
    expect(useVectorStatusUIStore.getState().isJobQueueActive).toBe(false);
  });

  it('mirrors background indexing status into the canonical snapshot', async () => {
    useBackgroundIndexingPreferencesStore.getState().setEnabled(true);
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    useBackgroundIndexingPreferencesStore.getState().setPaused(true);
    useWorkspaceCollectionSyncStatusStore.getState().setStatus({
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace cache',
      pauseReasons: ['Paused manually'],
      state: 'paused',
    });

    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
        background: {
          enabled: true,
          managedCollectionId: 'collection-a',
          managedCollectionName: 'Workspace cache',
          paused: true,
          pauseReasons: ['Paused manually'],
          state: 'paused',
        },
        phase: 'background-indexing',
        status: 'paused',
      });
    });
  });

  it('mirrors direct database scheduler pressure into the canonical snapshot', async () => {
    const listeners = new Set<(snapshot: IndexingDatabaseWorkSnapshot) => void>();
    const initialSnapshot = createDatabaseWorkSnapshot();
    databaseWorkSchedulerState.current = {
      getSnapshot: vi.fn(() => initialSnapshot),
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    };
    usePGliteDatabaseMock.mockReturnValue({ query: vi.fn() });

    render(<IndexingActivityCoordinator />);

    const pressureSnapshot = createDatabaseWorkSnapshot({
      backgroundWaiting: true,
      backgroundWaitingSince: 1000,
      backgroundYieldCount: 1,
      currentBackgroundWaitMs: 25,
      lastBackgroundYieldAt: 1000,
      lastForegroundAt: 950,
      queued: { background: 4, foreground: 1, normal: 0 },
    });
    for (const listener of listeners) {
      listener(pressureSnapshot);
    }

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
        databaseWork: pressureSnapshot,
        phase: 'background-indexing',
        status: 'active',
      });
    });
  });

  it('clears scheduler polling errors after a successful Electron snapshot refresh', async () => {
    liveQueryState.loading = true;
    const successfulSnapshot = createDatabaseWorkSnapshot({
      queued: { background: 0, foreground: 1, normal: 0 },
    });
    const firstSnapshot = createDeferred<IndexingDatabaseWorkSnapshot>();
    const secondSnapshot = createDeferred<IndexingDatabaseWorkSnapshot>();
    const schedulerSnapshot = vi
      .fn()
      .mockReturnValueOnce(firstSnapshot.promise)
      .mockReturnValue(secondSnapshot.promise);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        db: {
          schedulerSnapshot,
        },
      },
    });

    try {
      render(<IndexingActivityCoordinator />);

      await waitFor(() => {
        expect(schedulerSnapshot).toHaveBeenCalledTimes(1);
      });
      firstSnapshot.reject(new Error('scheduler unavailable'));

      await waitFor(() => {
        expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
          lastError: 'scheduler unavailable',
          status: 'error',
        });
      });

      await waitFor(() => {
        expect(schedulerSnapshot).toHaveBeenCalledTimes(2);
      });
      secondSnapshot.resolve(successfulSnapshot);

      await waitFor(() => {
        expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
          databaseWork: successfulSnapshot,
          lastError: null,
          status: 'active',
        });
      });
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: undefined,
      });
    }
  });
});
