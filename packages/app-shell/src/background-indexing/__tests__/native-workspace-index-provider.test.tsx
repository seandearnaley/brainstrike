import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { NativeWorkspaceIndexProvider } from '../native-workspace-index-provider';

const { adapter, roots, reconciliation } = vi.hoisted(() => ({
  adapter: { restoreRoots: vi.fn(async () => []) },
  reconciliation: { dbRootIdByAdapterRootId: new Map<string, string>(), registerRoot: vi.fn() },
  roots: [],
}));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => null }));
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ fileSystemAdapter: adapter }),
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ rootDirectoryHandles: roots }),
}));
vi.mock('../../roots/use-roots-reconciliation', () => ({
  useRootsReconciliation: () => reconciliation,
}));
beforeEach(() => {
  __resetBackgroundIndexingPreferencesStoreForTests();
  __resetWorkspaceCollectionSyncStatusStoreForTests();
});
it('names each missing native choice before polling closed admission, then observes the configured runtime', async () => {
  const capability = {
    coverage: vi.fn(),
    coverageBatch: vi.fn(),
    grep: vi.fn(),
    rebuild: vi.fn(),
    search: vi.fn(),
    status: vi.fn(async () => ({
      kind: 'unavailable' as const,
      reason: 'Waiting for native activation.',
    })),
  };
  const mounted = render(
    <NativeWorkspaceIndexProvider capability={capability}>
      <span>Workspace</span>
    </NativeWorkspaceIndexProvider>
  );
  await waitFor(() =>
    expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toContain('search mode')
  );
  act(() => useBackgroundIndexingPreferencesStore.getState().setNativeIndexMode('VECTOR'));
  await waitFor(() =>
    expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toContain('embedding model')
  );
  act(() => useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('selected'));
  await waitFor(() =>
    expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toContain(
      'local model execution'
    )
  );
  expect(capability.status).not.toHaveBeenCalled();
  act(() =>
    useBackgroundIndexingPreferencesStore.getState().setNativeLocalSelection({
      device: 'wasm',
      dimensions: 384,
      dtype: 'q8',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    })
  );
  await waitFor(() => expect(capability.status).toHaveBeenCalledOnce());
  expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toBe(
    'Waiting for native activation.'
  );
  mounted.unmount();
});
