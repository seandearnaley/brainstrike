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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexingStatusItem } from '../status-items/indexing-status-item';

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
    runningLabel: null,
    runningPriority: null,
    snapshotAt: 0,
    ...overrides,
  };
}

describe('IndexingStatusItem', () => {
  beforeEach(() => {
    __resetIndexingActivityStoreForTests();
    __resetBackgroundIndexingPreferencesStoreForTests();
  });

  it('renders unavailable instead of idle when the queue snapshot is unknown', () => {
    render(<IndexingStatusItem />);

    expect(screen.getByTestId('indexing-status-item')).toHaveTextContent('Indexing:Unavailable');
  });

  it('combines queue, background indexing, and active backfill state in one popover', async () => {
    useIndexingActivityStore.getState().setQueueSnapshot({
      queued: 8,
      running: 1,
      failed: 0,
      succeeded: 12,
      nextRunnableAt: null,
    });
    useIndexingActivityStore.getState().setBackfills([
      {
        embeddingSetId: 'collection-b',
        requestId: 'embedding-backfill:collection-b',
        source: 'manual',
        current: 4,
        total: 10,
      },
    ]);
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: null,
      paused: false,
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace cache',
      state: 'embedding',
      pauseReasons: [],
    });

    render(<IndexingStatusItem />);

    expect(screen.getByTestId('indexing-status-item')).toHaveTextContent('Indexing:Backfilling');

    await userEvent.click(screen.getByTestId('indexing-status-trigger'));

    expect(await screen.findByText('Indexing activity')).toBeInTheDocument();
    expect(screen.getByText('Workspace cache')).toBeInTheDocument();
    expect(screen.getByText('8 queued / 1 running / 0 failed / 12 succeeded')).toBeInTheDocument();
    expect(screen.getByText('collection-b')).toBeInTheDocument();
    expect(screen.getByText('Manual · 4/10')).toBeInTheDocument();
  });

  it('uses the existing background indexing pause preference', async () => {
    useBackgroundIndexingPreferencesStore.getState().setEnabled(true);
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: null,
      paused: false,
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace cache',
      state: 'idle',
      pauseReasons: [],
    });

    render(<IndexingStatusItem />);

    await userEvent.click(screen.getByTestId('indexing-status-trigger'));
    await userEvent.click(await screen.findByRole('button', { name: 'Pause background indexing' }));

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().paused).toBe(true);
    });
  });

  it('shows background indexing errors as blocked activity', () => {
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: 'No root folder selected.',
      paused: false,
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace cache',
      state: 'error',
      pauseReasons: [],
    });

    render(<IndexingStatusItem />);

    expect(screen.getByTestId('indexing-status-item')).toHaveTextContent('Indexing:Blocked');
  });

  it('shows when background indexing is yielding to foreground database work', async () => {
    useIndexingActivityStore.getState().setDatabaseWorkSnapshot(
      createDatabaseWorkSnapshot({
        backgroundWaiting: true,
        backgroundWaitingSince: 1000,
        backgroundYieldCount: 3,
        currentBackgroundWaitMs: 75,
        lastBackgroundYieldAt: 1000,
        lastForegroundAt: 950,
        priorityStats: {
          foreground: createPriorityStats({
            completed: 14,
            lastCompletedLabel: 'hybrid search',
            lastStartedLabel: 'hybrid search',
            queued: 14,
            serviceP95Ms: 16,
            started: 14,
            totalServiceMs: 112,
            totalWaitMs: 30,
            waitP95Ms: 8,
          }),
          normal: createPriorityStats(),
          background: createPriorityStats({
            completed: 9,
            lastCompletedLabel: 'embedding completion',
            lastStartedLabel: 'embedding claim',
            queued: 14,
            serviceP95Ms: 40,
            started: 9,
            totalServiceMs: 260,
            totalWaitMs: 225,
            waitP95Ms: 75,
          }),
        },
        queued: { foreground: 2, normal: 0, background: 5 },
      })
    );

    render(<IndexingStatusItem />);

    expect(screen.getByTestId('indexing-status-item')).toHaveTextContent('Indexing:Background');

    await userEvent.click(screen.getByTestId('indexing-status-trigger'));

    expect(await screen.findByText('Yielding to foreground database work')).toBeInTheDocument();
    expect(screen.getByText('2 foreground / 0 normal / 5 background')).toBeInTheDocument();
    expect(
      screen.getByText('14 foreground / 0 normal / 9 background completed')
    ).toBeInTheDocument();
    expect(screen.getByText('3 background yields / 225ms background wait')).toBeInTheDocument();
    expect(
      screen.getByText('FG p95 8ms wait / 16ms service · BG p95 75ms wait / 40ms service')
    ).toBeInTheDocument();
    expect(screen.getByText('FG hybrid search / BG embedding completion')).toBeInTheDocument();
    expect(screen.getByText(/waiting 75ms/)).toBeInTheDocument();
  });
});
