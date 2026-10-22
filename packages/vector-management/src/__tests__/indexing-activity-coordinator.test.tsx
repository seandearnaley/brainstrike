import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  __resetIndexingActivityStoreForTests,
  useIndexingActivityStore,
} from '@brainstrike/app-state/stores/indexing-activity-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexingActivityCoordinator } from '../indexing-activity-coordinator';

describe('IndexingActivityCoordinator', () => {
  beforeEach(() => {
    __resetIndexingActivityStoreForTests();
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
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
});
