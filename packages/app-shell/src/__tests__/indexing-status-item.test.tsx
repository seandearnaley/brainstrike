import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  __resetIndexingActivityStoreForTests,
  type IndexingDatabaseWorkPriorityStats,
  type IndexingDatabaseWorkSnapshot,
  type IndexingManagedCollectionStatsState,
  useIndexingActivityStore,
} from '@brainstrike/preferences/stores/indexing-activity-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexingStatusItem } from '../status-items/indexing-status-item';

function setManagedCollectionStats(managedCollectionStats: IndexingManagedCollectionStatsState) {
  useIndexingActivityStore.getState().setManagedCollectionStats(managedCollectionStats);
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

function seedReadyManagedStats(): void {
  setManagedCollectionStats({
    collectionId: 'collection-a',
    error: null,
    stats: {
      chunkCount: 128,
      dirty: false,
      embeddedChunkCount: 96,
      embeddingSetId: 'collection-a',
      fileCount: 24,
      lastRefreshedAt: '2026-07-09T12:00:00.000Z',
      pendingChunkCount: 32,
    },
    status: 'ready',
  });
}

describe('IndexingStatusItem', () => {
  beforeEach(() => {
    __resetIndexingActivityStoreForTests();
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
    setManagedCollectionStats({
      collectionId: null,
      error: null,
      stats: null,
      status: 'unavailable',
    });
  });

  it('keeps one coarse live status outside a fixed-width interactive trigger', () => {
    render(<IndexingStatusItem />);

    const trigger = screen.getByTestId('indexing-status-trigger');
    const status = screen.getByRole('status');
    const visualStatus = screen.getByTestId('indexing-status-item');
    const value = screen.getByTestId('indexing-status-value');

    expect(trigger).toHaveClass(
      'h-7',
      'w-7',
      'md:w-56',
      'cursor-pointer',
      'overflow-hidden',
      'whitespace-nowrap',
      'hover:bg-accent/80',
      'focus-visible:ring-1',
      'focus-visible:ring-inset'
    );
    expect(status).toHaveAttribute('data-testid', 'indexing-status-announcement');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('Workspace Index status: Unavailable');
    expect(status.closest('button')).toBeNull();
    expect(visualStatus).not.toHaveAttribute('role');
    expect(within(visualStatus).getByText('Workspace Index')).toHaveClass(
      'hidden',
      'min-w-0',
      'flex-1',
      'truncate',
      'whitespace-nowrap',
      'md:block'
    );
    expect(value).toHaveClass(
      'hidden',
      'w-20',
      'shrink-0',
      'overflow-hidden',
      'text-ellipsis',
      'whitespace-nowrap',
      'md:block',
      'tabular-nums'
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);

    act(() => {
      useBackgroundIndexingPreferencesStore.setState({ paused: true });
    });

    expect(status).toHaveTextContent('Workspace Index status: Paused');
  });

  it('uses contrast-safe semantic tones in light and dark themes', () => {
    useBackgroundIndexingPreferencesStore.setState({ enabled: true, paused: false });
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: null,
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace Index',
      paused: false,
      pauseReasons: [],
      state: 'idle',
    });

    render(<IndexingStatusItem />);

    const status = screen.getByTestId('indexing-status-item');
    expect(status).toHaveTextContent('Workspace IndexReady');
    expect(status).toHaveClass('text-emerald-800', 'dark:text-emerald-300');

    act(() => {
      useBackgroundIndexingPreferencesStore.setState({ paused: true });
    });

    expect(status).toHaveTextContent('Workspace IndexPaused');
    expect(status).toHaveClass('text-red-800', 'dark:text-red-300');
  });

  it('unifies managed counts, sync progress, queue activity, and diagnostics', async () => {
    useBackgroundIndexingPreferencesStore.getState().setIndexingPolicyPreset('full-root');
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    seedReadyManagedStats();
    useWorkspaceCollectionSyncStatusStore.getState().setStatus({
      activeRootPath: '/Users/sean/projects/brainstrike/packages/app-shell/src/status-items',
      embeddingProgress: {
        chunksProcessed: 7,
        currentChunk:
          'packages/app-shell/src/status-items/a-very-long-current-embedding-chunk-name.ts:40',
        modelName: 'local:bge-m3',
        totalChunks: 11,
      },
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace Index',
      queueProgress: {
        failed: 1,
        lastError: null,
        lastEvent: null,
        pending: 4,
        processed: 7,
        totalQueued: 12,
      },
      state: 'embedding',
    });
    useIndexingActivityStore.getState().setQueueSnapshot({
      failed: 0,
      nextRunnableAt: null,
      queued: 8,
      running: 1,
      succeeded: 12,
      succeededLifetime: 120,
    });
    useIndexingActivityStore.getState().setBackfills([
      {
        current: 4,
        embeddingSetId: 'collection-b',
        requestId: 'embedding-backfill:collection-b',
        source: 'manual',
        total: 10,
      },
    ]);
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: null,
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace Index',
      paused: false,
      pauseReasons: [],
      state: 'embedding',
    });
    useIndexingActivityStore.getState().setWorkerSnapshot({ lastError: null, state: 'running' });
    useIndexingActivityStore.getState().setDatabaseWorkSnapshot(
      createDatabaseWorkSnapshot({
        backgroundWaiting: true,
        backgroundWaitingSince: 1000,
        backgroundYieldCount: 3,
        currentBackgroundWaitMs: 75,
        priorityStats: {
          background: createPriorityStats({
            completed: 9,
            lastCompletedLabel: 'embedding completion',
            serviceP95Ms: 40,
            totalWaitMs: 225,
            waitP95Ms: 75,
          }),
          foreground: createPriorityStats({
            completed: 14,
            lastCompletedLabel: 'hybrid search',
            serviceP95Ms: 16,
            waitP95Ms: 8,
          }),
          normal: createPriorityStats(),
        },
        queued: { background: 5, foreground: 2, normal: 0 },
      })
    );

    render(<IndexingStatusItem />);

    expect(screen.getByTestId('indexing-status-item')).toHaveTextContent(
      'Workspace IndexBackfilling'
    );
    expect(screen.getByTestId('indexing-status-item')).toHaveClass(
      'text-sky-800',
      'dark:text-sky-300'
    );
    await userEvent.click(screen.getByTestId('indexing-status-trigger'));

    const popover = await screen.findByTestId('indexing-status-popover');
    expect(screen.getByRole('dialog', { name: 'Workspace Index' })).toBe(popover);
    expect(popover.className).toContain('w-[min(32rem,calc(100vw-1rem))]');
    expect(popover.className).toContain(
      'h-[min(32rem,var(--radix-popover-content-available-height))]'
    );
    expect(within(popover).getByTestId('managed-stat-files')).toHaveTextContent('24');
    expect(within(popover).getByTestId('managed-stat-chunks')).toHaveTextContent('128');
    expect(within(popover).getByTestId('managed-stat-embedded')).toHaveTextContent('96');
    expect(within(popover).getByTestId('managed-stat-pending')).toHaveTextContent('32');
    expect(within(popover).getByText('75%')).toBeInTheDocument();
    expect(
      within(popover).getByRole('progressbar', { name: 'Workspace Index embedding coverage' })
    ).toHaveAttribute('aria-valuenow', '75');
    expect(within(popover).getByText('8 queued · 1 running · 0 failed')).toBeInTheDocument();
    expect(within(popover).getByText('7 done · 4 pending · 1 failed')).toBeInTheDocument();
    expect(within(popover).getByText('Manual · 4/10')).toBeInTheDocument();
    expect(within(popover).getByText('Embedding chunk')).toBeInTheDocument();
    expect(within(popover).getByTitle(/a-very-long-current-embedding/)).toBeInTheDocument();
    expect(within(popover).getByText('Policy: Full root')).toBeInTheDocument();
    expect(within(popover).getAllByRole('button', { name: 'Pause workspace index' })).toHaveLength(
      1
    );
    expect(within(popover).getByTestId('indexing-action-region')).toHaveClass('h-11');
    expect(screen.getByTestId('indexing-status-item').querySelector('svg')).toHaveClass(
      'motion-reduce:animate-none'
    );

    expect(within(popover).queryByText('Worker state')).not.toBeInTheDocument();
    await userEvent.click(
      within(popover).getByRole('button', { name: 'Worker and database diagnostics' })
    );
    expect(within(popover).getByText('Worker state')).toBeInTheDocument();
    expect(within(popover).getByText('running')).toBeInTheDocument();
    expect(within(popover).getByText('2 foreground · 0 normal · 5 background')).toBeInTheDocument();
    expect(within(popover).getByText('3 yields · 225ms wait')).toBeInTheDocument();
    expect(within(popover).getByText('FG 8ms / 16ms · BG 75ms / 40ms')).toBeInTheDocument();
  });

  it('reserves stable metric and activity geometry while managed stats load', async () => {
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    setManagedCollectionStats({
      collectionId: 'collection-a',
      error: null,
      stats: null,
      status: 'loading',
    });
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: null,
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace Index',
      paused: false,
      pauseReasons: [],
      state: 'idle',
    });

    render(<IndexingStatusItem />);
    await userEvent.click(screen.getByTestId('indexing-status-trigger'));

    const popover = await screen.findByTestId('indexing-status-popover');
    const activityRegion = within(popover).getByTestId('indexing-activity-region');
    expect(activityRegion).toHaveClass('h-16');
    expect(within(popover).getByTestId('managed-stat-files')).toHaveTextContent('—');
    expect(within(popover).getByTestId('managed-stat-chunks')).toHaveTextContent('—');
    expect(within(popover).getByTestId('managed-stat-embedded')).toHaveTextContent('—');
    expect(within(popover).getByTestId('managed-stat-pending')).toHaveTextContent('—');
    expect(within(popover).getByText('Statistics are loading')).toBeInTheDocument();

    act(() => {
      seedReadyManagedStats();
    });

    await waitFor(() => {
      expect(within(popover).getByTestId('managed-stat-files')).toHaveTextContent('24');
    });
    expect(within(popover).getByTestId('indexing-activity-region')).toHaveClass('h-16');
    expect(within(popover).getByText('No active indexing work')).toBeInTheDocument();
  });

  it('surfaces a blocked sync error in the reserved activity region', async () => {
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    useWorkspaceCollectionSyncStatusStore.getState().setStatus({
      lastError: 'OpenAI API key not configured.',
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace Index',
      pauseReasons: ['missing provider key'],
      state: 'blocked',
    });
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: 'OpenAI API key not configured.',
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace Index',
      paused: false,
      pauseReasons: ['missing provider key'],
      state: 'blocked',
    });

    render(<IndexingStatusItem />);

    expect(screen.getByTestId('indexing-status-item')).toHaveTextContent('Workspace IndexBlocked');
    expect(screen.getByTestId('indexing-status-item')).toHaveClass(
      'text-amber-800',
      'dark:text-amber-300'
    );
    await userEvent.click(screen.getByTestId('indexing-status-trigger'));

    const activityRegion = await screen.findByTestId('indexing-activity-region');
    expect(activityRegion).toHaveClass('h-16');
    expect(within(activityRegion).getByText('OpenAI API key not configured.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause workspace index' })).not.toBeInTheDocument();
    expect(screen.getByTestId('indexing-action-region')).toHaveClass('h-11');
  });

  it('keeps the pause action available while a bound Workspace Index waits for restore', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      managedCollectionId: 'collection-a',
      paused: false,
    });
    useWorkspaceCollectionSyncStatusStore.getState().setStatus({
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace Index',
      state: 'waiting',
    });

    render(<IndexingStatusItem />);
    await userEvent.click(screen.getByTestId('indexing-status-trigger'));

    expect(
      await screen.findByRole('button', { name: 'Pause workspace index' })
    ).toBeInTheDocument();
  });

  it('marks retained dirty statistics as updating without moving the metric layout', async () => {
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    seedReadyManagedStats();
    const readyStats = useIndexingActivityStore.getState().managedCollectionStats.stats;
    setManagedCollectionStats({
      collectionId: 'collection-a',
      error: null,
      stats: readyStats ? { ...readyStats, dirty: true } : null,
      status: 'ready',
    });

    render(<IndexingStatusItem />);
    await userEvent.click(screen.getByTestId('indexing-status-trigger'));

    const popover = await screen.findByTestId('indexing-status-popover');
    expect(within(popover).getByText('75% · updating')).toBeInTheDocument();
    expect(within(popover).getByTestId('managed-stat-files')).toHaveTextContent('24');
  });
});
