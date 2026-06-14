import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { CollectionSyncStatusItem } from '../status-items/collection-sync-status-item';

describe('CollectionSyncStatusItem', () => {
  beforeEach(() => {
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
  });

  it('stays hidden when workspace indexing is disabled and has no status to surface', () => {
    useBackgroundIndexingPreferencesStore.getState().setEnabled(false);

    render(<CollectionSyncStatusItem />);

    expect(screen.queryByTestId('collection-sync-status-item')).not.toBeInTheDocument();
  });

  it('summarizes active embedding sync progress and can pause the workspace index', async () => {
    useBackgroundIndexingPreferencesStore.getState().setEnabled(true);
    useBackgroundIndexingPreferencesStore.getState().setIndexingPolicyPreset('full-root');
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    useWorkspaceCollectionSyncStatusStore.getState().setStatus({
      activeRootPath: '/Users/sean/projects/brainstrike/packages/app-shell/src/status-items',
      chunkingProgress: {
        chunksCreated: 18,
        currentFile:
          '/Users/sean/projects/brainstrike/packages/app-shell/src/status-items/cache.ts',
        filesProcessed: 5,
        strategyUsed: 'semantic',
        totalFiles: 8,
      },
      currentFilePath:
        '/Users/sean/projects/brainstrike/packages/app-shell/src/status-items/cache-status.ts',
      embeddingProgress: {
        chunksProcessed: 7,
        currentChunk: 'packages/app-shell/src/status-items/cache-status.ts:4',
        modelName: 'local:bge-m3',
        totalChunks: 11,
      },
      importProgress: {
        completed: 4,
        current:
          '/Users/sean/projects/brainstrike/packages/app-shell/src/status-items/cache-status.ts',
        errorCount: 1,
        total: 8,
      },
      managedCollectionName: 'Workspace cache',
      queueProgress: {
        failed: 1,
        lastError: null,
        lastEvent: {
          chunkId: 'chunk-7',
          elapsedMs: 42,
          model: 'local:bge-m3',
          status: 'completed',
        },
        pending: 4,
        processed: 7,
        totalQueued: 12,
      },
      scanSummary: {
        changedFiles: 8,
        discoveredFiles: 21,
        excludedEntries: 2,
        unchangedFiles: 11,
      },
      state: 'embedding',
    });

    render(<CollectionSyncStatusItem />);

    expect(screen.getByTestId('collection-sync-status-item')).toHaveTextContent(
      'Cache: Workspace cacheEmbedding'
    );

    await userEvent.click(screen.getByTestId('collection-sync-status-trigger'));

    expect(await screen.findByText('Workspace Index cache')).toBeInTheDocument();
    expect(screen.getByText('Policy: Full root')).toBeInTheDocument();
    expect(
      screen.getByText('21 eligible • 11 unchanged • 8 to update • 2 excluded entries')
    ).toBeInTheDocument();
    expect(screen.getByText('4/8 files • 1 error')).toBeInTheDocument();
    expect(screen.getByText('5/8 files • 18 chunks • semantic')).toBeInTheDocument();
    expect(screen.getByText('7/11 chunks • local:bge-m3')).toBeInTheDocument();
    expect(screen.getByText('7/12 done • 4 pending • 1 failed')).toBeInTheDocument();
    expect(screen.getByText('Embedding chunk')).toBeInTheDocument();
    expect(
      screen.getByText('packages/app-shell/src/status-items/cache-status.ts:4')
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Workspace Index' }));

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().paused).toBe(true);
    });
  });

  it('surfaces blocked sync errors without showing the pause control', async () => {
    useBackgroundIndexingPreferencesStore.getState().setEnabled(true);
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('collection-a');
    useWorkspaceCollectionSyncStatusStore.getState().setStatus({
      lastError: 'OpenAI API key not configured.',
      managedCollectionName: 'Workspace cache',
      pauseReasons: ['missing provider key'],
      state: 'blocked',
    });

    render(<CollectionSyncStatusItem />);

    expect(screen.getByTestId('collection-sync-status-item')).toHaveTextContent(
      'Cache: Workspace cacheBlocked'
    );

    await userEvent.click(screen.getByTestId('collection-sync-status-trigger'));

    expect(await screen.findByText('OpenAI API key not configured.')).toBeInTheDocument();
    expect(screen.getAllByText('Blocked')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Workspace Index' })).not.toBeInTheDocument();
  });
});
