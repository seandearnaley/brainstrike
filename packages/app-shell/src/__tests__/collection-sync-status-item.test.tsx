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
import { CollectionSyncStatusItem } from '../status-items/collection-sync-status-item';
import { IndexingStatusItem } from '../status-items/indexing-status-item';

describe('CollectionSyncStatusItem compatibility facade', () => {
  beforeEach(() => {
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetIndexingActivityStoreForTests();
  });

  it('is the unified IndexingStatusItem export rather than a second status implementation', () => {
    expect(CollectionSyncStatusItem).toBe(IndexingStatusItem);
  });

  it('renders the unified trigger and uses the single background-indexing pause action', async () => {
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    useIndexingActivityStore.getState().setBackgroundSnapshot({
      enabled: true,
      lastError: null,
      managedCollectionId: 'collection-a',
      managedCollectionName: 'Workspace Index',
      paused: false,
      pauseReasons: [],
      state: 'idle',
    });

    render(<CollectionSyncStatusItem />);

    expect(screen.getByTestId('indexing-status-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('collection-sync-status-trigger')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('indexing-status-trigger'));
    const pauseButton = await screen.findByRole('button', { name: 'Pause workspace index' });
    expect(
      screen.getAllByRole('button', { name: /^(Pause|Resume) workspace index$/ })
    ).toHaveLength(1);

    await userEvent.click(pauseButton);

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().paused).toBe(true);
    });
  });
});
