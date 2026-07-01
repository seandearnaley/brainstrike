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
  useModelRegistryDbClientMock,
  useOptionalProfileBootstrapReportMock,
  useBrainstrikeLiveQueryMock,
  useEmbeddingJobQueueMock,
  useSharedEmbeddingRuntimeMock,
} = vi.hoisted(() => {
  const databaseWorkSchedulerState = {
    current: null as {
      getSnapshot: ReturnType<typeof vi.fn>;
      subscribe: ReturnType<typeof vi.fn>;
    } | null,
  };
  return {
    databaseWorkSchedulerState,
    createPriorityDbHandleMock: vi.fn((db: unknown) => db),
    getDatabaseWorkSchedulerMock: vi.fn(() => databaseWorkSchedulerState.current),
    makeLiveQueryKeyMock: vi.fn((...args: readonly unknown[]) => JSON.stringify(args)),
    useModelRegistryDbClientMock: vi.fn((): unknown => null),
    useOptionalProfileBootstrapReportMock: vi.fn((): unknown => null),
    useBrainstrikeLiveQueryMock: vi.fn(),
    useEmbeddingJobQueueMock: vi.fn((): unknown => null),
    useSharedEmbeddingRuntimeMock: vi.fn(),
  };
});

interface LiveQueryState {
  error: Error | null;
  loading: boolean;
  rows: unknown[];
}

const liveQueryState: LiveQueryState = {
  rows: [],
  loading: false,
  error: null,
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
      foreground: createPriorityStats(),
      normal: createPriorityStats(),
      background: createPriorityStats(),
    },
    queued: { foreground: 0, normal: 0, background: 0 },
    queuedLabels: { foreground: [], normal: [], background: [] },
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
  useModelRegistryDbClient: useModelRegistryDbClientMock,
  useOptionalProfileBootstrapReport: useOptionalProfileBootstrapReportMock,
  useBrainstrikeLiveQuery: useBrainstrikeLiveQueryMock,
}));

vi.mock('../embedding-runtime-provider', () => ({
  useSharedEmbeddingRuntime: useSharedEmbeddingRuntimeMock,
}));

vi.mock('../use-embedding-job-queue', () => ({
  useEmbeddingJobQueue: useEmbeddingJobQueueMock,
}));

function createRuntimeStatus(
  state: EmbeddingRuntimeStatus['state'],
  lastError: string | null = null
): EmbeddingRuntimeStatus {
  return {
    runtimeKind: 'embedding-worker',
    runtimeId: 'embedding-worker:test',
    state,
    active: state === 'running',
    lastError,
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
    useModelRegistryDbClientMock.mockReturnValue(null);
    useOptionalProfileBootstrapReportMock.mockReturnValue(null);
    useEmbeddingJobQueueMock.mockReturnValue(null);
    useBrainstrikeLiveQueryMock.mockImplementation(() => ({
      rows: liveQueryState.rows,
      loading: liveQueryState.loading,
      error: liveQueryState.error,
      refresh: vi.fn(async () => {}),
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
          queued: '7',
          running: '1',
          failed: '0',
          succeeded: '23',
          nextRunnableAt: '2026-04-25T12:00:00.000Z',
        },
      ],
    }));
    const db = { query };
    useModelRegistryDbClientMock.mockReturnValue(db);
    useOptionalProfileBootstrapReportMock.mockReturnValue({
      ready: true,
      runtime: { engine: 'pglite' },
    });

    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
        status: 'active',
        phase: 'queue',
        queue: {
          queued: 7,
          running: 1,
          failed: 0,
          succeeded: 23,
          nextRunnableAt: '2026-04-25T12:00:00.000Z',
        },
      });
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM job_queue'), ['embeddings']);
    expect(createPriorityDbHandleMock).toHaveBeenCalledWith(db, 'background');
    expect(useBrainstrikeLiveQueryMock).not.toHaveBeenCalled();
    expect(useVectorStatusUIStore.getState().durableQueueStats).toEqual({
      queued: 7,
      running: 1,
      failed: 0,
      succeeded: 23,
      nextRunnableAt: '2026-04-25T12:00:00.000Z',
    });
    expect(useVectorStatusUIStore.getState().isJobQueueActive).toBe(true);
  });

  it('samples queue state from the runtime job queue when PGlite is unavailable', async () => {
    const query = vi.fn();
    const getQueueStats = vi.fn(async () => [
      {
        queue: 'embeddings',
        queued: 4,
        running: 2,
        failed: 1,
        succeeded: 12,
        nextRunnableAt: '2026-04-25T12:05:00.000Z',
      },
    ]);
    useModelRegistryDbClientMock.mockReturnValue({ query });
    useOptionalProfileBootstrapReportMock.mockReturnValue({
      ready: true,
      runtime: { engine: 'turso' },
    });
    useEmbeddingJobQueueMock.mockReturnValue({ getQueueStats });

    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
        status: 'error',
        phase: 'queue',
        lastError: '1 embedding job failed',
        queue: {
          queued: 4,
          running: 2,
          failed: 1,
          succeeded: 12,
          nextRunnableAt: '2026-04-25T12:05:00.000Z',
        },
      });
    });

    expect(getQueueStats).toHaveBeenCalledWith('embeddings', {
      label: 'indexing activity queue snapshot',
      priority: 'background',
    });
    expect(query).not.toHaveBeenCalled();
    expect(createPriorityDbHandleMock).not.toHaveBeenCalled();
    expect(useVectorStatusUIStore.getState().durableQueueStats).toEqual({
      queued: 4,
      running: 2,
      failed: 1,
      succeeded: 12,
      nextRunnableAt: '2026-04-25T12:05:00.000Z',
    });
    expect(useVectorStatusUIStore.getState().isJobQueueActive).toBe(true);
  });

  it('routes runtime queue stats polling through the background database lane', async () => {
    const query = vi.fn();
    const getQueueStats = vi.fn(async () => []);
    useModelRegistryDbClientMock.mockReturnValue({ query });
    useOptionalProfileBootstrapReportMock.mockReturnValue({
      ready: true,
      runtime: { engine: 'turso' },
    });
    useEmbeddingJobQueueMock.mockReturnValue({ getQueueStats });

    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(getQueueStats).toHaveBeenCalledWith('embeddings', {
        label: 'indexing activity queue snapshot',
        priority: 'background',
      });
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'idle',
      phase: null,
      queue: {
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 0,
        nextRunnableAt: null,
      },
    });
    expect(useVectorStatusUIStore.getState().durableQueueStats).toEqual({
      queued: 0,
      running: 0,
      failed: 0,
      succeeded: 0,
      nextRunnableAt: null,
    });
    expect(query).not.toHaveBeenCalled();
    expect(useVectorStatusUIStore.getState().isJobQueueActive).toBe(false);
  });

  it('keeps backfills visible across collections through runtime in-flight state', async () => {
    const runtime = createMockRuntime();
    vi.mocked(runtime.controller.getBackfillsInFlight).mockResolvedValue([
      {
        embeddingSetId: 'collection-b',
        requestId: 'embedding-backfill:collection-b',
        source: 'manual',
        progress: { current: 2, total: 9 },
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
          embeddingSetId: 'collection-b',
          requestId: 'embedding-backfill:collection-b',
          source: 'manual',
          current: 2,
          total: 9,
        },
      ]);
    });

    runtime.emitBackfillProgress({
      embeddingSetId: 'collection-c',
      requestId: 'background-indexing-backfill:collection-c',
      source: 'background-indexing',
      stage: 'backfill',
      current: 5,
      total: 11,
    });

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot.activeBackfills).toEqual([
        {
          embeddingSetId: 'collection-c',
          requestId: 'background-indexing-backfill:collection-c',
          source: 'background-indexing',
          current: 5,
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
        status: 'unavailable',
        phase: null,
        queue: null,
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
      state: 'paused',
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace cache',
      pauseReasons: ['Paused manually'],
    });

    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
        status: 'paused',
        phase: 'background-indexing',
        background: {
          enabled: true,
          paused: true,
          managedCollectionId: 'collection-a',
          managedCollectionName: 'Workspace cache',
          state: 'paused',
          pauseReasons: ['Paused manually'],
        },
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
    useModelRegistryDbClientMock.mockReturnValue({ query: vi.fn() });
    useOptionalProfileBootstrapReportMock.mockReturnValue({
      ready: true,
      runtime: { engine: 'pglite' },
    });

    render(<IndexingActivityCoordinator />);

    const pressureSnapshot = createDatabaseWorkSnapshot({
      backgroundWaiting: true,
      backgroundWaitingSince: 1000,
      backgroundYieldCount: 1,
      currentBackgroundWaitMs: 25,
      lastBackgroundYieldAt: 1000,
      lastForegroundAt: 950,
      queued: { foreground: 1, normal: 0, background: 4 },
    });
    for (const listener of listeners) {
      listener(pressureSnapshot);
    }

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
        status: 'active',
        phase: 'background-indexing',
        databaseWork: pressureSnapshot,
      });
    });
  });

  it('clears scheduler polling errors after a successful Electron snapshot refresh', async () => {
    liveQueryState.loading = true;
    const successfulSnapshot = createDatabaseWorkSnapshot({
      queued: { foreground: 1, normal: 0, background: 0 },
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
          lastError: null,
          status: 'active',
          databaseWork: successfulSnapshot,
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
