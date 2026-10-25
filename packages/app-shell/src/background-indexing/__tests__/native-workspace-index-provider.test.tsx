import { useIndexConfigStore } from '@brainstrike/app-state/stores/index-config-store';
import {
  __resetIndexingActivityStoreForTests,
  useIndexingActivityStore,
} from '@brainstrike/app-state/stores/indexing-activity-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
  fault,
  refusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import type {
  IndexerCoverageBatch,
  IndexerCoverageRequest,
  IndexerStatus,
  NativeIndexObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import { act } from '@brainstrike/test-utils/react-act';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeWorkspaceIndexProvider } from '../native-workspace-index-provider';

const { adapter, roots, reconciliation } = vi.hoisted(() => ({
  adapter: { restoreRoots: vi.fn(async () => []) },
  reconciliation: {
    dbRootIdByAdapterRootId: new Map<string, string>(),
    registerRoot: vi.fn(),
    syncMountedRoots: vi.fn(async () => undefined),
  },
  roots: [{ path: '/owned/repo', rootId: 'root' }],
}));
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ fileSystemAdapter: adapter }),
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ rootDirectoryHandles: roots }),
}));
vi.mock('../../roots/use-roots-reconciliation', () => ({
  useRootsReconciliation: () => reconciliation,
}));
const SEMANTIC_CONFIG: IndexConfig = {
  ...DEFAULT_INDEX_CONFIG,
  mode: 'semantic',
  model: {
    dimensions: 384,
    local: { device: 'wasm', dtype: 'q8' },
    modelKey: 'transformers::Xenova/all-MiniLM-L6-v2',
  },
};

/** What Main sends for its lifecycle owner's typed refusals (`nativeIndexBoundaryFailure`). */
const CLOSED = refusal({
  category: 'availability',
  code: 'native-index-closed',
  message: 'The search index is closed.',
  remedy: 'Reopen the workspace to search again.',
});
const TRANSITIONING = refusal({
  category: 'availability',
  code: 'native-index-transitioning',
  message: 'The search index is preparing.',
});
const SOURCE_FAILURE = refusal({
  category: 'availability',
  code: 'native-index-source-failure',
  message: 'The search index could not prepare its sources.',
  remedy:
    'Rebuild the search index in Settings, Search & Indexing. Chats, folders and settings are kept.',
});

/** Main's side of the config: one read, then every change it publishes. */
function mainConfig(read: () => Promise<IndexConfig>) {
  let listener: ((config: IndexConfig) => void) | undefined;
  return {
    onConfigChanged: (next: (config: IndexConfig) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    publish: (config: IndexConfig) => act(() => listener?.(config)),
    readConfig: vi.fn(read),
    updateConfig: vi.fn(),
  };
}

const savedConfig = (config: IndexConfig) => mainConfig(async () => config);

/** Main's index observations: each one it pushes after its index changed. */
function mainIndex() {
  let listener: ((observation: NativeIndexObservation) => void) | undefined;
  return {
    onLifecycleChanged: (next: (observation: NativeIndexObservation) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    push: (progress: NativeIndexObservation['progress']) =>
      act(() => listener?.({ lifecycle: { generation: 1, kind: 'ready' }, progress })),
  };
}

beforeEach(() => {
  __resetIndexingActivityStoreForTests();
  useIndexConfigStore.setState({ state: { kind: 'loading' }, update: null });
  __resetWorkspaceCollectionSyncStatusStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

it('shows what Main pushes when its index changes, and nothing new until it pushes again', async () => {
  vi.useFakeTimers();
  const status: IndexerStatus = {
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: ['root'],
    embedding: { indexMode: 'text-only' },
    kind: 'ready',
    rootReadiness: [{ rootId: 'root', scanComplete: true }],
    storeId: 'store',
  };
  const settled = (indexedFiles: number): IndexerCoverageBatch => {
    const counts = { chunks: indexedFiles * 4, indexedFiles, missingVectors: 0, vectors: 0 };
    return {
      coverage: [
        {
          embedding: status.embedding,
          roots: [{ rootId: 'root', ...counts }],
          storeId: 'store',
          totals: counts,
          vectorCoverageComplete: true,
        },
      ],
      kind: 'current',
      status,
    };
  };
  const index = mainIndex();
  const capability = {
    ...savedConfig(DEFAULT_INDEX_CONFIG),
    ...index,
    coverage: vi.fn(),
    coverageBatch: vi.fn(async (): Promise<IndexerCoverageBatch> => settled(54)),
    grep: vi.fn(),
    rebuild: vi.fn(),
    rootsRegistered: vi.fn(async () => {}),
    search: vi.fn(),
    status: vi.fn(async (): Promise<IndexerStatus> => status),
  };
  const mounted = render(
    <NativeWorkspaceIndexProvider capability={capability}>
      <span>Workspace</span>
    </NativeWorkspaceIndexProvider>
  );
  await vi.waitFor(() =>
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      processedFiles: 54,
      state: 'idle',
    })
  );
  // The index grows, but Main has not said so: what the app shows stays as it was.
  capability.coverageBatch.mockImplementation(async () => settled(99));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(useWorkspaceCollectionSyncStatusStore.getState().processedFiles).toBe(54);
  // Main's next observation is what the app shows.
  index.push({ coverage: settled(120), kind: 'read', status });
  expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
    processedFiles: 120,
    state: 'idle',
  });
  expect(useIndexingActivityStore.getState().managedCollectionStats.stats?.fileCount).toBe(120);
  mounted.unmount();
});

it('waits for Main’s config before reading the index, then follows each change', async () => {
  let answer: (config: IndexConfig) => void = () => {};
  const main = mainConfig(
    () =>
      new Promise<IndexConfig>((resolve) => {
        answer = resolve;
      })
  );
  const capability = {
    ...main,
    coverage: vi.fn(),
    coverageBatch: vi.fn(),
    grep: vi.fn(),
    onLifecycleChanged: vi.fn(() => () => {}),
    rebuild: vi.fn(),
    rootsRegistered: vi.fn(async () => {}),
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
  await waitFor(() => expect(main.readConfig).toHaveBeenCalledOnce());
  expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('waiting');
  expect(capability.status).not.toHaveBeenCalled();
  act(() => answer(SEMANTIC_CONFIG));
  await waitFor(() => expect(capability.status).toHaveBeenCalledOnce());
  expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toBe(
    'Waiting for native activation.'
  );
  main.publish({ ...SEMANTIC_CONFIG, paused: true });
  expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('paused');
  main.publish({ ...SEMANTIC_CONFIG, mode: 'off' });
  expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('disabled');
  mounted.unmount();
});

it('shows why Main could not read the config instead of waiting forever', async () => {
  const failure = fault({
    category: 'internal',
    code: 'index-config.store-failed',
    correlationId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    message: 'The search index settings could not be read.',
  });
  const capability = {
    ...mainConfig(async () => {
      throw new BoundaryFailureError(failure);
    }),
    coverage: vi.fn(),
    coverageBatch: vi.fn(),
    grep: vi.fn(),
    onLifecycleChanged: vi.fn(() => () => {}),
    rebuild: vi.fn(),
    rootsRegistered: vi.fn(async () => {}),
    search: vi.fn(),
    status: vi.fn(),
  };
  const mounted = render(
    <NativeWorkspaceIndexProvider capability={capability}>
      <span>Workspace</span>
    </NativeWorkspaceIndexProvider>
  );
  await waitFor(() =>
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      lastError: describeBoundaryFailure(failure),
      state: 'error',
    })
  );
  expect(capability.status).not.toHaveBeenCalled();
  mounted.unmount();
});

it.each([
  ['closed', CLOSED],
  ['preparing', TRANSITIONING],
])(
  'waits, with no error, when Main refuses the config read because its index is %s, then follows the config Main publishes',
  async (_kind, failure) => {
    // Main's config read reaches the agent-host profile, which a reset or quit has closed.
    // Once the reset reopens the profile, Main publishes its config; nothing reads again.
    const main = mainConfig(async () => {
      throw new BoundaryFailureError(failure);
    });
    const status: IndexerStatus = {
      authorizedCollectionIds: [],
      authorizedRootIds: [],
      embedding: { indexMode: 'text-only' },
      kind: 'ready',
      rootReadiness: [],
      storeId: 'store',
    };
    const counts = { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 };
    const capability = {
      ...main,
      coverage: vi.fn(),
      coverageBatch: vi.fn(
        async (): Promise<IndexerCoverageBatch> => ({
          coverage: [
            {
              embedding: status.embedding,
              roots: [],
              storeId: 'store',
              totals: counts,
              vectorCoverageComplete: true,
            },
          ],
          kind: 'current',
          status,
        })
      ),
      grep: vi.fn(),
      onLifecycleChanged: vi.fn(() => () => {}),
      rebuild: vi.fn(),
      rootsRegistered: vi.fn(async () => {}),
      search: vi.fn(),
      status: vi.fn(async (): Promise<IndexerStatus> => status),
    };
    const mounted = render(
      <NativeWorkspaceIndexProvider capability={capability}>
        <span>Workspace</span>
      </NativeWorkspaceIndexProvider>
    );
    await waitFor(() => expect(useIndexConfigStore.getState().state.kind).toBe('failed'));
    await act(async () => {});
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      lastError: null,
      state: 'waiting',
    });
    expect(capability.status).not.toHaveBeenCalled();
    main.publish(DEFAULT_INDEX_CONFIG);
    await waitFor(() => expect(capability.status).toHaveBeenCalled());
    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
        lastError: null,
        state: 'idle',
      })
    );
    expect(main.readConfig).toHaveBeenCalledOnce();
    mounted.unmount();
  }
);

it('observes an atomic batch and preserves acknowledged counters across ordinary mutation invalidation', async () => {
  const status = {
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: ['root'],
    embedding: { indexMode: 'text-only' as const },
    kind: 'ready' as const,
    rootReadiness: [{ rootId: 'root', scanComplete: false }],
    storeId: 'store',
  };
  const counts = { chunks: 251, indexedFiles: 54, missingVectors: 0, vectors: 251 };
  const coverage = {
    embedding: status.embedding,
    roots: [{ rootId: 'root', ...counts }],
    storeId: 'store',
    totals: counts,
    vectorCoverageComplete: true,
  };
  const index = mainIndex();
  const capability = {
    ...savedConfig(SEMANTIC_CONFIG),
    ...index,
    coverage: vi.fn(async () => {
      throw new Error('strict observation invalidated');
    }),
    coverageBatch: vi.fn(
      async (): Promise<IndexerCoverageBatch> => ({ coverage: [coverage], kind: 'current', status })
    ),
    grep: vi.fn(),
    rebuild: vi.fn(),
    rootsRegistered: vi.fn(async () => {}),
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
  index.push({
    coverage: { code: 'native-coverage-observation-invalidated', kind: 'invalidated' },
    kind: 'read',
    status,
  });
  expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
    activeRootPath: '/owned/repo',
    lastError: null,
    processedFiles: 54,
    state: 'scanning',
  });
  index.push({
    kind: 'read',
    status: { kind: 'unavailable', phase: 'preparing', reason: 'Authority transition.' },
  });
  expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
    lastError: null,
    processedFiles: 54,
    state: 'scanning',
  });
  index.push({ kind: 'failed', reason: 'Stored vector payload is corrupt.' });
  expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
    lastError: 'Stored vector payload is corrupt.',
    processedFiles: 54,
    state: 'error',
  });
  mounted.unmount();
});

it.each(['roots', 'profile', 'store'] as const)(
  'clears previous counters when %s identity changes during an invalidated observation',
  async (changed) => {
    let status: Extract<IndexerStatus, { kind: 'ready' }> = {
      authorizedCollectionIds: ['selected', 'next'],
      authorizedRootIds: ['root'],
      embedding: { indexMode: 'text-only' },
      kind: 'ready',
      rootReadiness: [{ rootId: 'root', scanComplete: false }],
      storeId: 'store',
    };
    const counts = { chunks: 251, indexedFiles: 54, missingVectors: 0, vectors: 251 };
    const index = mainIndex();
    const capability = {
      ...savedConfig(SEMANTIC_CONFIG),
      ...index,
      coverage: vi.fn(),
      coverageBatch: vi.fn(
        async (): Promise<IndexerCoverageBatch> => ({
          coverage: [
            {
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
      rootsRegistered: vi.fn(async () => {}),
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
    if (changed === 'roots') {
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
    index.push({
      coverage: { code: 'native-coverage-observation-invalidated', kind: 'invalidated' },
      kind: 'read',
      status,
    });
    expect(useIndexingActivityStore.getState().managedCollectionStats.stats).toBeNull();
    expect(useWorkspaceCollectionSyncStatusStore.getState().processedFiles).toBe(0);
    expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toBeNull();
    mounted.unmount();
  }
);

it.each(['status', 'batch'] as const)(
  'keeps a retained startup failure from %s visibly blocked across observations and exposes its actionable reason',
  async (source) => {
    const reason =
      'Native indexing is blocked: Indexer startup exceeded its caller-provided deadline. Open Diagnostics for details.';
    const index = mainIndex();
    const capability = {
      ...savedConfig(SEMANTIC_CONFIG),
      ...index,
      coverage: vi.fn(),
      coverageBatch: vi.fn(
        async (): Promise<IndexerCoverageBatch> => ({ kind: 'blocked', reason })
      ),
      grep: vi.fn(),
      rebuild: vi.fn(),
      rootsRegistered: vi.fn(async () => {}),
      search: vi.fn(),
      status: vi.fn(
        async (): Promise<IndexerStatus> =>
          source === 'status'
            ? { kind: 'unavailable', phase: 'blocked', reason }
            : {
                authorizedCollectionIds: ['selected'],
                authorizedRootIds: ['root'],
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
    // Main reports the same retained failure after its next change.
    const status = await capability.status();
    index.push(
      status.kind === 'ready'
        ? {
            coverage: await capability.coverageBatch(),
            kind: 'read',
            status,
          }
        : { kind: 'read', status }
    );
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      lastError: reason,
      state: 'blocked',
    });
    mounted.unmount();
  }
);

it.each(['status', 'batch'] as const)(
  'carries an unresponsive embedding host from %s as the blocked reason that offers Retry indexing (BST-2104)',
  async (source) => {
    const reason =
      'The embedding model stopped responding while it was loading. It sent no progress for 1 min (1 min after the batch started).';
    const cause = { kind: 'embedding-host-unresponsive' as const, message: reason };
    let unresponsive = true;
    const index = mainIndex();
    const capability = {
      ...savedConfig(SEMANTIC_CONFIG),
      ...index,
      coverage: vi.fn(),
      coverageBatch: vi.fn(
        async (): Promise<IndexerCoverageBatch> =>
          unresponsive
            ? { cause, kind: 'blocked', reason }
            : {
                cause: { kind: 'source-failure', message: 'Workspace walk failed.' },
                kind: 'blocked',
                reason: 'Workspace walk failed.',
              }
      ),
      grep: vi.fn(),
      rebuild: vi.fn(),
      rootsRegistered: vi.fn(async () => {}),
      search: vi.fn(),
      status: vi.fn(
        async (): Promise<IndexerStatus> =>
          source === 'status'
            ? unresponsive
              ? { cause, kind: 'unavailable', phase: 'blocked', reason }
              : {
                  cause: { kind: 'source-failure', message: 'Workspace walk failed.' },
                  kind: 'unavailable',
                  phase: 'blocked',
                  reason: 'Workspace walk failed.',
                }
            : {
                authorizedCollectionIds: ['selected'],
                authorizedRootIds: ['root'],
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
        blockedReason: 'embedding-host-unresponsive',
        lastError: reason,
        state: 'blocked',
      })
    );
    // A block with any other cause names no remedy.
    unresponsive = false;
    const status = await capability.status();
    index.push(
      status.kind === 'ready'
        ? {
            coverage: await capability.coverageBatch(),
            kind: 'read',
            status,
          }
        : { kind: 'read', status }
    );
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      blockedReason: null,
      lastError: 'Workspace walk failed.',
      state: 'blocked',
    });
    mounted.unmount();
  }
);

it.each([
  { files: 2, label: 'one folder', rootIds: ['root'] },
  { files: 0, label: 'no folder left', rootIds: [] },
])(
  'reports Text search ready with no collection: $label (BST-1988)',
  async ({ files, rootIds }) => {
    // The shape the desktop recorded for the TEXT partition: roots only, no collection.
    const status = {
      authorizedCollectionIds: [],
      authorizedRootIds: rootIds,
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
      ...savedConfig(DEFAULT_INDEX_CONFIG),
      coverage: vi.fn(),
      coverageBatch: vi.fn(
        async (requests: readonly IndexerCoverageRequest[]): Promise<IndexerCoverageBatch> => {
          // As the native capability does: an empty workspace scope is refused.
          if (requests.some((request) => request.rootIds.length === 0)) {
            throw new Error('Native workspace search requires connected roots.');
          }
          return { coverage: [coverage], kind: 'current', status };
        }
      ),
      grep: vi.fn(),
      onLifecycleChanged: vi.fn(() => () => {}),
      rebuild: vi.fn(),
      rootsRegistered: vi.fn(async () => {}),
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
    // With no folder there is nothing to cover, so nothing is asked.
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

it.each([
  {
    category: 'configuration',
    code: 'embedding.missing-key',
    message: 'No API key configured for the embedding provider.',
    remedy: 'Configure the embedding provider API key in Settings, then retry indexing.',
  },
  {
    category: 'input',
    code: 'embedding.input-too-long',
    message: 'The embedding provider refused the input as too large.',
    remedy: 'Reduce the text sent for embedding, then retry.',
  },
  {
    category: 'availability',
    code: 'embedding.rate-limit',
    message: 'The embedding provider is rate limiting requests.',
    remedy: 'Wait for the provider rate limit to clear, then retry.',
  },
] as const)(
  'keeps the native $code remedy visible without its private cause',
  async (description) => {
    const failure = refusal(description);
    const capability = {
      ...savedConfig(SEMANTIC_CONFIG),
      coverage: vi.fn(),
      coverageBatch: vi.fn(),
      grep: vi.fn(),
      onLifecycleChanged: vi.fn(() => () => {}),
      rebuild: vi.fn(),
      rootsRegistered: vi.fn(async () => {}),
      search: vi.fn(),
      status: vi.fn(async () => {
        throw new BoundaryFailureError(failure, { cause: new Error('private fixture diagnostic') });
      }),
    };
    const mounted = render(
      <NativeWorkspaceIndexProvider capability={capability}>
        <span>Workspace</span>
      </NativeWorkspaceIndexProvider>
    );
    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toBe(
        describeBoundaryFailure(failure)
      )
    );
    expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).not.toContain(
      'private fixture diagnostic'
    );
    mounted.unmount();
  }
);

const PREPARING: IndexerStatus = {
  kind: 'unavailable',
  phase: 'preparing',
  reason: 'Native index is transitioning.',
};

it.each([
  { failure: CLOSED, state: 'waiting' },
  { failure: TRANSITIONING, state: 'waiting' },
  { failure: SOURCE_FAILURE, state: 'error' },
] as const)(
  'shows $failure.code from restoring roots as sync state $state',
  async ({ failure, state }) => {
    reconciliation.syncMountedRoots.mockRejectedValueOnce(new BoundaryFailureError(failure));
    const capability = {
      ...savedConfig(DEFAULT_INDEX_CONFIG),
      coverage: vi.fn(),
      coverageBatch: vi.fn(),
      grep: vi.fn(),
      onLifecycleChanged: vi.fn(() => () => {}),
      rebuild: vi.fn(),
      rootsRegistered: vi.fn(async () => {}),
      search: vi.fn(),
      status: vi.fn(async () => PREPARING),
    };
    const mounted = render(
      <NativeWorkspaceIndexProvider capability={capability}>
        <span>Workspace</span>
      </NativeWorkspaceIndexProvider>
    );
    await waitFor(() => expect(capability.status).toHaveBeenCalled());
    await waitFor(() => expect(reconciliation.syncMountedRoots).toHaveBeenCalled());
    await act(async () => {});
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      lastError: state === 'error' ? describeBoundaryFailure(failure) : null,
      state,
    });
    mounted.unmount();
  }
);

/** What Main's `status()` answers when its read is refused: it catches the refusal (scoped-search). */
it.each([
  {
    lastError: null,
    state: 'waiting',
    status: {
      cause: { kind: 'closed', reason: 'reset' },
      kind: 'unavailable',
      phase: 'preparing',
      reason: 'Native index activation is closed for terminal retirement.',
    },
  },
  {
    lastError: null,
    state: 'waiting',
    status: { cause: { kind: 'transitioning' }, ...PREPARING },
  },
  {
    lastError: 'Initial native workspace scan was aborted.',
    state: 'blocked',
    status: {
      cause: { kind: 'source-failure', message: 'Initial native workspace scan was aborted.' },
      kind: 'unavailable',
      phase: 'blocked',
      reason: 'Initial native workspace scan was aborted.',
    },
  },
] as const satisfies readonly {
  lastError: string | null;
  state: string;
  status: IndexerStatus;
}[])(
  'shows a status refused with $status.cause.kind as sync state $state',
  async ({ lastError, state, status }) => {
    const capability = {
      ...savedConfig(DEFAULT_INDEX_CONFIG),
      coverage: vi.fn(),
      coverageBatch: vi.fn(),
      grep: vi.fn(),
      onLifecycleChanged: vi.fn(() => () => {}),
      rebuild: vi.fn(),
      rootsRegistered: vi.fn(async () => {}),
      search: vi.fn(),
      status: vi.fn(async (): Promise<IndexerStatus> => status),
    };
    const mounted = render(
      <NativeWorkspaceIndexProvider capability={capability}>
        <span>Workspace</span>
      </NativeWorkspaceIndexProvider>
    );
    await waitFor(() => expect(capability.status).toHaveBeenCalled());
    await waitFor(() => expect(reconciliation.syncMountedRoots).toHaveBeenCalled());
    await act(async () => {});
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({ lastError, state });
    mounted.unmount();
  }
);
