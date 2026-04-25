import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetIndexingActivityStoreForTests,
  useIndexingActivityStore,
} from '../stores/indexing-activity-store';

describe('indexing-activity-store', () => {
  beforeEach(() => {
    __resetIndexingActivityStoreForTests();
  });

  it('starts unavailable instead of defaulting unknown queue state to idle zeroes', () => {
    expect(useIndexingActivityStore.getState().snapshot).toEqual({
      status: 'unavailable',
      phase: null,
      queue: null,
      activeBackfills: [],
      background: {
        enabled: false,
        paused: false,
        managedCollectionId: null,
        managedCollectionName: null,
        state: 'disabled',
        pauseReasons: [],
      },
      worker: null,
      lastError: null,
      lastUpdatedAt: null,
    });
  });

  it('reports idle only after an explicit empty queue snapshot exists', () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      queued: 0,
      running: 0,
      failed: 0,
      succeeded: 4,
      nextRunnableAt: null,
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'idle',
      phase: null,
      queue: {
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 4,
        nextRunnableAt: null,
      },
    });
    expect(useIndexingActivityStore.getState().snapshot.lastUpdatedAt).toEqual(expect.any(Number));
  });

  it('derives active queue state from queued and running jobs', () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      queued: 8,
      running: 2,
      failed: 0,
      succeeded: 20,
      nextRunnableAt: '2026-04-25T12:00:00.000Z',
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'active',
      phase: 'queue',
      queue: {
        queued: 8,
        running: 2,
        failed: 0,
        succeeded: 20,
        nextRunnableAt: '2026-04-25T12:00:00.000Z',
      },
    });
  });

  it('keeps manual backfills visible independently of the active collection', () => {
    useIndexingActivityStore.getState().setBackfills([
      {
        embeddingSetId: 'set-other',
        requestId: 'embedding-backfill:1',
        source: 'manual',
        current: 3,
        total: 10,
      },
    ]);

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'active',
      phase: 'manual-backfill',
      activeBackfills: [
        {
          embeddingSetId: 'set-other',
          requestId: 'embedding-backfill:1',
          source: 'manual',
          current: 3,
          total: 10,
        },
      ],
    });
  });

  it('reports paused background indexing before idle queue state', () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      queued: 0,
      running: 0,
      failed: 0,
      succeeded: 2,
      nextRunnableAt: null,
    });
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      paused: true,
      managedCollectionId: 'set-1',
      managedCollectionName: 'Workspace cache',
      state: 'paused',
      pauseReasons: ['Paused manually'],
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'paused',
      phase: 'background-indexing',
      background: {
        enabled: true,
        paused: true,
        managedCollectionId: 'set-1',
        managedCollectionName: 'Workspace cache',
        state: 'paused',
        pauseReasons: ['Paused manually'],
      },
    });
  });

  it('reports errors from queue, worker, background, or explicit activity error', () => {
    useIndexingActivityStore.getState().setWorkerSnapshot({
      state: 'error',
      lastError: 'Embedding worker crashed',
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'error',
      phase: 'embedding',
      worker: {
        state: 'error',
        lastError: 'Embedding worker crashed',
      },
      lastError: 'Embedding worker crashed',
    });

    useIndexingActivityStore.getState().setWorkerSnapshot(null);
    useIndexingActivityStore.getState().setQueueSnapshot({
      queued: 0,
      running: 0,
      failed: 1,
      succeeded: 2,
      nextRunnableAt: null,
    });

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'error',
      phase: 'queue',
      lastError: '1 embedding job failed',
    });

    useIndexingActivityStore.getState().setIndexingActivityError('Live query failed');

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'error',
      lastError: 'Live query failed',
    });
  });

  it('resets back to unavailable', () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      queued: 1,
      running: 0,
      failed: 0,
      succeeded: 0,
      nextRunnableAt: null,
    });

    useIndexingActivityStore.getState().resetIndexingActivity();

    expect(useIndexingActivityStore.getState().snapshot).toMatchObject({
      status: 'unavailable',
      phase: null,
      queue: null,
      lastUpdatedAt: null,
    });
  });
});
