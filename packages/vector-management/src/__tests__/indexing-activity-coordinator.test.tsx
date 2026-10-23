import { useIndexConfigStore } from '@brainstrike/app-state/stores/index-config-store';
import {
  __resetIndexingActivityStoreForTests,
  useIndexingActivityStore,
} from '@brainstrike/app-state/stores/indexing-activity-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { DEFAULT_INDEX_CONFIG } from '@brainstrike/assistant-contract/index-config';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexingActivityCoordinator } from '../indexing-activity-coordinator';

describe('IndexingActivityCoordinator', () => {
  beforeEach(() => {
    __resetIndexingActivityStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
    useIndexConfigStore.setState({ state: { kind: 'loading' }, update: null });
  });

  it('mirrors background indexing status into the canonical snapshot', async () => {
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

  it('reports indexing as off only once Main’s config says so, never while it is unread', async () => {
    // The sync status starts out disabled, before anything has been read.
    render(<IndexingActivityCoordinator />);

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot.background).toMatchObject({
        enabled: true,
        state: 'disabled',
      });
    });

    act(() => {
      useIndexConfigStore.setState({
        state: { config: { ...DEFAULT_INDEX_CONFIG, mode: 'off' }, kind: 'ready' },
      });
    });

    await waitFor(() => {
      expect(useIndexingActivityStore.getState().snapshot.background).toMatchObject({
        enabled: false,
        paused: false,
        state: 'disabled',
      });
    });
  });
});
