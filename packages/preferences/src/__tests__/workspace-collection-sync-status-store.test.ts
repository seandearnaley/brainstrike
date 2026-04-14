import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '../stores/workspace-collection-sync-status-store';

describe('workspace-collection-sync-status-store', () => {
  beforeEach(() => {
    __resetWorkspaceCollectionSyncStatusStoreForTests();
  });

  it('initializes with disabled status and no active root', () => {
    const state = useWorkspaceCollectionSyncStatusStore.getState();

    expect(state).toMatchObject({
      state: 'disabled',
      managedCollectionId: null,
      managedCollectionName: null,
      currentFilePath: null,
      queuedFiles: 0,
      processedFiles: 0,
      lastError: null,
      activeRootPath: null,
    });
  });

  it('applies status patches without dropping prior fields', () => {
    const store = useWorkspaceCollectionSyncStatusStore.getState();

    store.setStatus({
      state: 'scanning',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      activeRootPath: '/workspace/a',
      queuedFiles: 12,
      currentFilePath: 'src/index.ts',
    });

    store.setStatus({
      state: 'embedding',
      processedFiles: 4,
    });

    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      state: 'embedding',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      activeRootPath: '/workspace/a',
      queuedFiles: 12,
      processedFiles: 4,
      currentFilePath: 'src/index.ts',
    });
  });

  it('clears transient progress while preserving disabled baseline on reset', () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      state: 'error',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      currentFilePath: 'src/index.ts',
      queuedFiles: 99,
      processedFiles: 2,
      lastError: 'boom',
      activeRootPath: '/workspace/a',
    });

    useWorkspaceCollectionSyncStatusStore.getState().reset();

    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      state: 'disabled',
      managedCollectionId: null,
      managedCollectionName: null,
      currentFilePath: null,
      queuedFiles: 0,
      processedFiles: 0,
      lastError: null,
      activeRootPath: null,
    });
  });
});
