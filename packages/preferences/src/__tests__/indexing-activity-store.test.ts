import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetIndexingActivityStoreForTests,
  type IndexingDatabaseWorkPriorityStats,
  type IndexingDatabaseWorkSnapshot,
  type IndexingManagedCollectionStats,
  useIndexingActivityStore,
} from '../stores/indexing-activity-store';

const MANAGED_COLLECTION_STATS: IndexingManagedCollectionStats = {
  chunkCount: 42,
  dirty: false,
  embeddedChunkCount: 30,
  embeddingSetId: 'workspace-index-a',
  fileCount: 7,
  lastRefreshedAt: '2026-07-09T12:00:00.000Z',
  pendingChunkCount: 12,
};

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

describe('indexing-activity-store', () => {
  beforeEach(() => {
    __resetIndexingActivityStoreForTests();
  });

  it('starts unavailable instead of defaulting unknown queue state to idle zeroes', () => {
    expect(useIndexingActivityStore.getState().snapshot).toEqual({
      activeBackfills: [],
      background: {
        enabled: false,
        lastError: null,
        managedCollectionId: null,
        managedCollectionName: null,
        paused: false,
        pauseReasons: [],
        state: 'disabled',
      },
      databaseWork: null,
      lastError: null,
      lastUpdatedAt: null,
      phase: null,
      queue: null,
      status: 'unavailable',
      worker: null,
    });
  });

  it('starts managed collection stats explicitly unavailable', () => {
    expect(useIndexingActivityStore.getState().managedCollectionStats).toEqual({
      collectionId: null,
      error: null,
      stats: null,
      status: 'unavailable',
    });
  });

  it('stores explicit managed collection stats lifecycle states without inventing zeroes', () => {
    const { setManagedCollectionStats } = useIndexingActivityStore.getState();

    setManagedCollectionStats({
      collectionId: 'workspace-index-a',
      error: null,
      stats: null,
      status: 'loading',
    });
    expect(useIndexingActivityStore.getState().managedCollectionStats).toEqual({
      collectionId: 'workspace-index-a',
      error: null,
      stats: null,
      status: 'loading',
    });

    setManagedCollectionStats({
      collectionId: 'workspace-index-a',
      error: null,
      stats: null,
      status: 'pending',
    });
    expect(useIndexingActivityStore.getState().managedCollectionStats).toEqual({
      collectionId: 'workspace-index-a',
      error: null,
      stats: null,
      status: 'pending',
    });

    setManagedCollectionStats({
      collectionId: 'workspace-index-a',
      error: null,
      stats: MANAGED_COLLECTION_STATS,
      status: 'ready',
    });
    expect(useIndexingActivityStore.getState().managedCollectionStats).toEqual({
      collectionId: 'workspace-index-a',
      error: null,
      stats: MANAGED_COLLECTION_STATS,
      status: 'ready',
    });
  });

  it('allows an error state to retain last-known stats for the same managed collection', () => {
    useIndexingActivityStore.getState().setManagedCollectionStats({
      collectionId: 'workspace-index-a',
      error: 'Managed collection stats query failed',
      stats: MANAGED_COLLECTION_STATS,
      status: 'error',
    });

    expect(useIndexingActivityStore.getState().managedCollectionStats).toEqual({
      collectionId: 'workspace-index-a',
      error: 'Managed collection stats query failed',
      stats: MANAGED_COLLECTION_STATS,
      status: 'error',
    });
  });

  it('reports idle only after an explicit empty queue snapshot exists', () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      failed: 0,
      nextRunnableAt: null,
      queued: 0,
      running: 0,
      succeeded: 4,
      succeededLifetime: 4,
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      phase: null,
      queue: {
        failed: 0,
        nextRunnableAt: null,
        queued: 0,
        running: 0,
        succeeded: 4,
        succeededLifetime: 4,
      },
      status: 'idle',
    });
    expect(useIndexingActivityStore.getState().snapshot.lastUpdatedAt).toEqual(expect.any(Number));
  });

  it('does not report idle from a stopped worker without an explicit queue snapshot', () => {
    useIndexingActivityStore.getState().setWorkerSnapshot({
      lastError: null,
      state: 'stopped',
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      phase: null,
      queue: null,
      status: 'unavailable',
      worker: {
        lastError: null,
        state: 'stopped',
      },
    });
  });

  it('derives active queue state from queued and running jobs', () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      failed: 0,
      nextRunnableAt: '2026-04-25T12:00:00.000Z',
      queued: 8,
      running: 2,
      succeeded: 20,
      succeededLifetime: 20,
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      phase: 'queue',
      queue: {
        failed: 0,
        nextRunnableAt: '2026-04-25T12:00:00.000Z',
        queued: 8,
        running: 2,
        succeeded: 20,
        succeededLifetime: 20,
      },
      status: 'active',
    });
  });

  it('reports active background indexing when database work is yielding to foreground work', () => {
    useIndexingActivityStore.getState().setDatabaseWorkSnapshot(
      createDatabaseWorkSnapshot({
        backgroundWaiting: true,
        backgroundWaitingSince: 1000,
        backgroundYieldCount: 1,
        currentBackgroundWaitMs: 50,
        lastForegroundAt: 900,
        queued: { background: 4, foreground: 1, normal: 0 },
      })
    );

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      databaseWork: {
        backgroundWaiting: true,
        queued: { background: 4, foreground: 1, normal: 0 },
      },
      phase: 'background-indexing',
      status: 'active',
    });
  });

  it('keeps manual backfills visible independently of the active collection', () => {
    useIndexingActivityStore.getState().setBackfills([
      {
        current: 3,
        embeddingSetId: 'set-other',
        requestId: 'embedding-backfill:1',
        source: 'manual',
        total: 10,
      },
    ]);

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      activeBackfills: [
        {
          current: 3,
          embeddingSetId: 'set-other',
          requestId: 'embedding-backfill:1',
          source: 'manual',
          total: 10,
        },
      ],
      phase: 'manual-backfill',
      status: 'active',
    });
  });

  it('reports paused background indexing before idle queue state', () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      failed: 0,
      nextRunnableAt: null,
      queued: 0,
      running: 0,
      succeeded: 2,
      succeededLifetime: 2,
    });
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: null,
      managedCollectionId: 'set-1',
      managedCollectionName: 'Workspace cache',
      paused: true,
      pauseReasons: ['Paused manually'],
      state: 'paused',
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      background: {
        enabled: true,
        lastError: null,
        managedCollectionId: 'set-1',
        managedCollectionName: 'Workspace cache',
        paused: true,
        pauseReasons: ['Paused manually'],
        state: 'paused',
      },
      phase: 'background-indexing',
      status: 'paused',
    });
  });

  it('reports errors from queue, worker, background, or explicit activity error', () => {
    useIndexingActivityStore.getState().setWorkerSnapshot({
      lastError: 'Embedding worker crashed',
      state: 'error',
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      lastError: 'Embedding worker crashed',
      phase: 'embedding',
      status: 'error',
      worker: {
        lastError: 'Embedding worker crashed',
        state: 'error',
      },
    });

    useIndexingActivityStore.getState().setWorkerSnapshot(null);
    useIndexingActivityStore.getState().setQueueSnapshot({
      failed: 1,
      nextRunnableAt: null,
      queued: 0,
      running: 0,
      succeeded: 2,
      succeededLifetime: 2,
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      lastError: '1 embedding job failed',
      phase: 'queue',
      status: 'error',
    });

    useIndexingActivityStore.getState().setQueueSnapshot({
      failed: 0,
      nextRunnableAt: null,
      queued: 0,
      running: 0,
      succeeded: 2,
      succeededLifetime: 2,
    });
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: 'No root folder selected.',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Workspace cache',
      paused: false,
      pauseReasons: [],
      state: 'error',
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      lastError: 'No root folder selected.',
      phase: 'background-indexing',
      status: 'error',
    });

    useIndexingActivityStore.getState().setIndexingActivityError('Live query failed');

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      lastError: 'Live query failed',
      status: 'error',
    });
  });

  it('resets back to unavailable', () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      failed: 0,
      nextRunnableAt: null,
      queued: 1,
      running: 0,
      succeeded: 0,
      succeededLifetime: 0,
    });
    useIndexingActivityStore.getState().setManagedCollectionStats({
      collectionId: 'workspace-index-a',
      error: null,
      stats: MANAGED_COLLECTION_STATS,
      status: 'ready',
    });

    useIndexingActivityStore.getState().resetIndexingActivity();

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      lastUpdatedAt: null,
      phase: null,
      queue: null,
      status: 'unavailable',
    });
    expect(useIndexingActivityStore.getState().managedCollectionStats).toEqual({
      collectionId: null,
      error: null,
      stats: null,
      status: 'unavailable',
    });
  });
});
