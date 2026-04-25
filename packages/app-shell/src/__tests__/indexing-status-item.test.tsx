import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  __resetIndexingActivityStoreForTests,
  useIndexingActivityStore,
} from '@brainstrike/preferences/stores/indexing-activity-store';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexingStatusItem } from '../status-items/indexing-status-item';

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
});
