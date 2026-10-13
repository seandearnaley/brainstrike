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
import type {
  IndexerCoverageBatch,
  IndexerCoverageRequest,
  IndexerStatus,
} from '@brainstrike/indexing-contract/indexer-client';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { NativeWorkspaceIndexProvider } from '../native-workspace-index-provider';

const { adapter, roots, reconciliation } = vi.hoisted(() => ({
  adapter: { restoreRoots: vi.fn(async () => []) },
  reconciliation: { dbRootIdByAdapterRootId: new Map<string, string>(), registerRoot: vi.fn() },
  roots: [{ path: '/owned/repo', rootId: 'root' }],
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
  __resetIndexingActivityStoreForTests();
  __resetBackgroundIndexingPreferencesStoreForTests();
  __resetWorkspaceCollectionSyncStatusStoreForTests();
});
it('reports missing mode and collection, then lets native authority validate provider-specific execution without blocking hosted models', async () => {
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
  await waitFor(() => expect(capability.status).toHaveBeenCalledOnce());
  expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toBe(
    'Waiting for native activation.'
  );
  mounted.unmount();
});

it('observes an atomic batch and preserves acknowledged counters across ordinary mutation invalidation', async () => {
  useBackgroundIndexingPreferencesStore.setState({
    managedCollectionId: 'selected',
    nativeIndexMode: 'VECTOR',
  });
  const status = {
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: ['root'],
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
    embedding: { indexMode: 'text-only' as const },
    kind: 'ready' as const,
    rootReadiness: [{ rootId: 'root', scanComplete: false }],
    storeId: 'store',
  };
  const counts = { chunks: 251, indexedFiles: 54, missingVectors: 0, vectors: 251 };
  const coverage = {
    collections: [{ embeddingSetId: 'selected', ...counts }],
    embedding: status.embedding,
    roots: [{ rootId: 'root', ...counts }],
    storeId: 'store',
    totals: counts,
    vectorCoverageComplete: true,
  };
  const capability = {
    coverage: vi.fn(async () => {
      throw new Error('strict observation invalidated');
    }),
    coverageBatch: vi.fn(
      async (): Promise<IndexerCoverageBatch> => ({ coverage: [coverage], kind: 'current', status })
    ),
    grep: vi.fn(),
    rebuild: vi.fn(),
    search: vi.fn(),
    status: vi.fn(async (): Promise<IndexerStatus> => status),
  };
  const mounted = render(
    <NativeWorkspaceIndexProvider capability={capability}>
      <span>Workspace</span>
    </NativeWorkspaceIndexProvider>
  );
  await waitFor(() =>
    expect(useWorkspaceCollectionSyncStatusStore.getState().processedFiles).toBe(54)
  );
  expect(capability.coverage).not.toHaveBeenCalled();
  expect(useIndexingActivityStore.getState().managedCollectionStats.stats?.fileCount).toBe(54);
  capability.coverageBatch.mockImplementation(async () => ({
    code: 'native-coverage-observation-invalidated',
    kind: 'invalidated',
  }));
  await waitFor(() => expect(capability.coverageBatch).toHaveBeenCalledTimes(2), { timeout: 4000 });
  expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
    activeRootPath: '/owned/repo',
    lastError: null,
    processedFiles: 54,
    state: 'scanning',
  });
  const statusReads = capability.status.mock.calls.length;
  capability.status.mockResolvedValueOnce({
    kind: 'unavailable',
    phase: 'preparing',
    reason: 'Authority transition.',
  });
  await waitFor(() => expect(capability.status.mock.calls.length).toBeGreaterThan(statusReads), {
    timeout: 4000,
  });
  expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
    lastError: null,
    processedFiles: 54,
    state: 'scanning',
  });
  capability.coverageBatch.mockRejectedValueOnce(new Error('Stored vector payload is corrupt.'));
  await waitFor(
    () => expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('error'),
    { timeout: 4000 }
  );
  const failedReadCount = capability.coverageBatch.mock.calls.length;
  await waitFor(
    () => expect(capability.coverageBatch.mock.calls.length).toBeGreaterThan(failedReadCount),
    { timeout: 4000 }
  );
  expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
    lastError: 'Stored vector payload is corrupt.',
    processedFiles: 54,
    state: 'error',
  });
  mounted.unmount();
});

it.each(['collection', 'roots', 'profile', 'store'] as const)(
  'clears previous counters when %s identity changes during an invalidated observation',
  async (changed) => {
    useBackgroundIndexingPreferencesStore.setState({
      managedCollectionId: 'selected',
      nativeIndexMode: 'VECTOR',
    });
    let status: Extract<IndexerStatus, { kind: 'ready' }> = {
      authorizedCollectionIds: ['selected', 'next'],
      authorizedRootIds: ['root'],
      embedding: { indexMode: 'text-only' },
      kind: 'ready',
      rootReadiness: [{ rootId: 'root', scanComplete: false }],
      storeId: 'store',
    };
    const counts = { chunks: 251, indexedFiles: 54, missingVectors: 0, vectors: 251 };
    const capability = {
      coverage: vi.fn(),
      coverageBatch: vi.fn(
        async (): Promise<IndexerCoverageBatch> => ({
          coverage: [
            {
              collections: [{ embeddingSetId: 'selected', ...counts }],
              embedding: status.embedding,
              roots: [{ rootId: 'root', ...counts }],
              storeId: status.storeId,
              totals: counts,
              vectorCoverageComplete: true,
            },
          ],
          kind: 'current',
          status,
        })
      ),
      grep: vi.fn(),
      rebuild: vi.fn(),
      search: vi.fn(),
      status: vi.fn(async () => status),
    };
    const mounted = render(
      <NativeWorkspaceIndexProvider capability={capability}>
        <span>Workspace</span>
      </NativeWorkspaceIndexProvider>
    );
    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState().processedFiles).toBe(54)
    );
    capability.coverageBatch.mockImplementation(async () => ({
      code: 'native-coverage-observation-invalidated',
      kind: 'invalidated',
    }));
    if (changed === 'collection') {
      act(() => useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('next'));
    } else if (changed === 'roots') {
      status = { ...status, authorizedRootIds: ['new-root'] };
    } else if (changed === 'store') {
      status = { ...status, storeId: 'rebuilt-store' };
    } else {
      status = {
        ...status,
        embedding: {
          indexMode: 'vector-configured',
          profile: {
            dimensions: 384,
            distance: 'cosine',
            dtype: 'q4',
            modelId: 'onnx-community/all-MiniLM-L6-v2',
            provider: 'transformers',
          },
          profileHash: 'profile',
        },
      };
    }
    await waitFor(
      () => expect(useIndexingActivityStore.getState().managedCollectionStats.stats).toBeNull(),
      { timeout: 4000 }
    );
    expect(useWorkspaceCollectionSyncStatusStore.getState().processedFiles).toBe(0);
    expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toBeNull();
    mounted.unmount();
  }
);

it.each(['status', 'batch'] as const)(
  'keeps a retained startup failure from %s visibly blocked across polling and exposes its actionable reason',
  async (source) => {
    useBackgroundIndexingPreferencesStore.setState({
      managedCollectionId: 'selected',
      nativeIndexMode: 'VECTOR',
    });
    const reason =
      'Native indexing is blocked: Indexer startup exceeded its caller-provided deadline. Open Diagnostics for details.';
    const capability = {
      coverage: vi.fn(),
      coverageBatch: vi.fn(
        async (): Promise<IndexerCoverageBatch> => ({ kind: 'blocked', reason })
      ),
      grep: vi.fn(),
      rebuild: vi.fn(),
      search: vi.fn(),
      status: vi.fn(
        async (): Promise<IndexerStatus> =>
          source === 'status'
            ? { kind: 'unavailable', phase: 'blocked', reason }
            : {
                authorizedCollectionIds: ['selected'],
                authorizedRootIds: ['root'],
                collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
                embedding: { indexMode: 'text-only' },
                kind: 'ready',
                rootReadiness: [{ rootId: 'root', scanComplete: false }],
                storeId: 'store',
              }
      ),
    };
    const mounted = render(
      <NativeWorkspaceIndexProvider capability={capability}>
        <span>Workspace</span>
      </NativeWorkspaceIndexProvider>
    );
    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
        lastError: reason,
        state: 'blocked',
      })
    );
    await waitFor(() => expect(capability.status).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      lastError: reason,
      state: 'blocked',
    });
    if (source === 'status') {
      expect(capability.coverageBatch).not.toHaveBeenCalled();
    } else {
      expect(capability.coverageBatch).toHaveBeenCalledTimes(2);
    }
    mounted.unmount();
  }
);

it.each([
  { files: 2, label: 'one folder', rootIds: ['root'] },
  { files: 0, label: 'no folder left', rootIds: [] },
])(
  'reports Text search ready with no collection: $label (BST-1988)',
  async ({ files, rootIds }) => {
    useBackgroundIndexingPreferencesStore.setState({
      managedCollectionId: null,
      nativeIndexMode: 'TEXT',
    });
    // The shape the desktop recorded for the TEXT partition: roots only, no collection.
    const status = {
      authorizedCollectionIds: [],
      authorizedRootIds: rootIds,
      collectionReadiness: [],
      embedding: { indexMode: 'text-only' as const },
      kind: 'ready' as const,
      rootReadiness: rootIds.map((rootId) => ({ rootId, scanComplete: true })),
      storeId: 'store',
    };
    const counts = { chunks: files * 2, indexedFiles: files, missingVectors: 0, vectors: 0 };
    const coverage = {
      embedding: status.embedding,
      roots: rootIds.map((rootId) => ({ rootId, ...counts })),
      storeId: 'store',
      totals: counts,
      vectorCoverageComplete: true,
    };
    const capability = {
      coverage: vi.fn(),
      coverageBatch: vi.fn(
        async (requests: readonly IndexerCoverageRequest[]): Promise<IndexerCoverageBatch> => {
          // As the native capability does: an empty workspace scope is refused.
          if (requests.some((request) => request.rootIds.length === 0 && !request.collectionId)) {
            throw new Error('Native workspace search requires connected roots.');
          }
          return { coverage: [coverage], kind: 'current', status };
        }
      ),
      grep: vi.fn(),
      rebuild: vi.fn(),
      search: vi.fn(),
      status: vi.fn(async (): Promise<IndexerStatus> => status),
    };
    const mounted = render(
      <NativeWorkspaceIndexProvider capability={capability}>
        <span>Workspace</span>
      </NativeWorkspaceIndexProvider>
    );
    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('idle')
    );
    // With no folder and no collection there is nothing to cover, so nothing is asked.
    expect(capability.coverageBatch).toHaveBeenCalledTimes(rootIds.length === 0 ? 0 : 1);
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      lastError: null,
      managedCollectionId: null,
      processedFiles: files,
    });
    expect(useIndexingActivityStore.getState().managedCollectionStats).toMatchObject({
      collectionId: null,
      stats: {
        chunkCount: files * 2,
        embeddingSetId: null,
        fileCount: files,
        pendingChunkCount: 0,
      },
      status: 'ready',
    });
    mounted.unmount();
  }
);
