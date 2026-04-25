import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  __resetIndexingActivityStoreForTests,
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

const { makeLiveQueryKeyMock, usePGliteLiveQueryMock, useSharedEmbeddingRuntimeMock } = vi.hoisted(
  () => ({
    makeLiveQueryKeyMock: vi.fn((...args: readonly unknown[]) => JSON.stringify(args)),
    usePGliteLiveQueryMock: vi.fn(),
    useSharedEmbeddingRuntimeMock: vi.fn(),
  })
);

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

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: makeLiveQueryKeyMock,
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
    usePGliteLiveQueryMock.mockImplementation(() => ({
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

  it('reports active queue state from a live aggregate without app activity gating', async () => {
    liveQueryState.rows = [
      {
        queued: '7',
        running: '1',
        failed: '0',
        succeeded: '23',
        nextRunnableAt: '2026-04-25T12:00:00.000Z',
      },
    ];

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

    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        params: ['embeddings'],
      })
    );
    expect(useVectorStatusUIStore.getState().durableQueueStats).toEqual({
      queued: 7,
      running: 1,
      failed: 0,
      succeeded: 23,
      nextRunnableAt: '2026-04-25T12:00:00.000Z',
    });
    expect(useVectorStatusUIStore.getState().isJobQueueActive).toBe(true);
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
});
