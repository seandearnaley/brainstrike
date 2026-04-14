import type { EmbeddingSet } from '@brainstrike/db';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { encodeFileSelection } from '@brainstrike/utils';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceCollectionSyncProvider } from '../workspace-collection-sync-provider';

const {
  runEnhancedImportMock,
  readFullTreeWithOptionsMock,
  processFilesMock,
  listManagedCacheEntryMetadataMock,
  createWithContentMock,
  updateMock,
  deleteByFileRecordIdMock,
  getByIdMock,
  validateApiKeyForSetMock,
  ensureChunkingWorkerMock,
  ensureEmbeddingRuntimeStartedMock,
  enqueueBackfillMock,
  fileSystemState,
  fileTreeContextState,
} = vi.hoisted(() => ({
  runEnhancedImportMock: vi.fn(),
  readFullTreeWithOptionsMock: vi.fn(),
  processFilesMock: vi.fn(),
  listManagedCacheEntryMetadataMock: vi.fn(),
  createWithContentMock: vi.fn(),
  updateMock: vi.fn(),
  deleteByFileRecordIdMock: vi.fn(),
  getByIdMock: vi.fn(),
  validateApiKeyForSetMock: vi.fn(),
  ensureChunkingWorkerMock: vi.fn(),
  ensureEmbeddingRuntimeStartedMock: vi.fn(),
  enqueueBackfillMock: vi.fn(async () => {}),
  fileSystemState: {
    isAccessLoading: false,
    rootDirectoryHandle: {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    },
  },
  fileTreeContextState: {
    current: {
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
    } as {
      isRestorationSettled: boolean;
      isRestoringExpandedPaths: boolean;
      restorationProgress: null;
    } | null,
  },
}));

vi.mock('@brainstrike/db', () => ({
  JobQueue: vi.fn(function MockJobQueue() {
    return {
      enqueueBatch: vi.fn(),
      clear: vi.fn(),
      getQueueStats: vi.fn(async () => []),
      requeueFailed: vi.fn(),
    };
  }),
  usePGliteDatabase: () => ({
    query: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
  }),
  useFileRecordRepository: () => ({
    listManagedCacheEntryMetadata: listManagedCacheEntryMetadataMock,
    createWithContent: createWithContentMock,
    update: updateMock,
  }),
  useFileChunkRepository: () => ({
    deleteByFileRecordId: deleteByFileRecordIdMock,
    update: vi.fn(),
  }),
  useEmbeddingSetsRepository: () => ({
    getById: getByIdMock,
  }),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: { readDirectory: vi.fn(), readFile: vi.fn() },
  }),
  createFileContentProcessor: () => ({
    processFiles: processFilesMock,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  useFileSystem: () => ({
    isAccessLoading: fileSystemState.isAccessLoading,
    rootDirectoryHandle: fileSystemState.rootDirectoryHandle,
  }),
  useOptionalFileTreeContext: () => fileTreeContextState.current,
  readFullTreeWithOptions: readFullTreeWithOptionsMock,
}));

vi.mock('@brainstrike/file-import/chunking-worker-context', () => ({
  useChunkingWorkerContext: () => ({
    port: {
      isReady: () => true,
      transportKind: 'local',
    },
    ensureStarted: ensureChunkingWorkerMock,
  }),
}));

vi.mock('@brainstrike/file-import', () => ({
  backfillEmbeddingSetAssignments: vi.fn(async () => undefined),
  runEnhancedImport: runEnhancedImportMock,
}));

vi.mock('@brainstrike/vector-management', () => ({
  useSharedEmbeddingRuntime: vi.fn(() => ({
    controller: {
      cancelAllBackfills: vi.fn(async () => {}),
      enqueueBackfill: enqueueBackfillMock,
      ensureStarted: ensureEmbeddingRuntimeStartedMock,
      getBackfillsInFlight: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({
        runtimeKind: 'embedding-host',
        runtimeId: 'embedding-host:test',
        state: 'running',
        active: false,
        lastError: null,
      })),
      onBackfillProgress: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      reset: vi.fn(async () => ({
        runtimeKind: 'embedding-host',
        runtimeId: 'embedding-host:test',
        state: 'running',
        active: false,
        lastError: null,
      })),
      start: vi.fn(async () => ({
        runtimeKind: 'embedding-host',
        runtimeId: 'embedding-host:test',
        state: 'running',
        active: false,
        lastError: null,
      })),
      stop: vi.fn(async () => ({
        runtimeKind: 'embedding-host',
        runtimeId: 'embedding-host:test',
        state: 'stopped',
        active: false,
        lastError: null,
      })),
    },
    service: {
      validateApiKeyForSet: validateApiKeyForSetMock,
    },
  })),
}));

describe('WorkspaceCollectionSyncProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemState.isAccessLoading = false;
    fileSystemState.rootDirectoryHandle = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    };
    fileTreeContextState.current = {
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
    };
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();

    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      mode: 'root-folder-cache',
      hasHydrated: true,
    });

    const collection: EmbeddingSet = {
      id: '00000000-0000-0000-0000-000000000101',
      name: 'Managed Cache',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      dimensions: 1536,
      distance: 'cosine',
      createdAt: new Date().toISOString(),
    };

    getByIdMock.mockResolvedValue(collection);
    validateApiKeyForSetMock.mockResolvedValue({ valid: true });
    ensureChunkingWorkerMock.mockResolvedValue({
      isReady: () => true,
      transportKind: 'host-proxy',
      chunkBatch: vi.fn(),
      chunkFile: vi.fn(),
      terminate: vi.fn(),
    });
    ensureEmbeddingRuntimeStartedMock.mockResolvedValue({
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host:test',
      state: 'running',
      active: false,
      lastError: null,
    });
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        type: 'file',
        handle: { platform: 'electron', path: '/workspace/root/src/index.ts' },
        rootFolderId: '/workspace/root',
      },
    ]);
    processFilesMock.mockResolvedValue({
      [encodeFileSelection('/workspace/root', 'src/index.ts')]: 'export const value = 1;',
    });
    listManagedCacheEntryMetadataMock.mockResolvedValue([]);
    runEnhancedImportMock.mockImplementation(async (params) => {
      await params.baseImportRunner({
        selectedFilePaths: params.request.selectedFilePaths,
        fileTree: params.request.fileTree,
        fileContents: params.request.fileContents,
        onProgress: () => {},
      });
      return [];
    });
  });

  it('starts background indexing when settings are enabled without requiring the DB tab', async () => {
    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(ensureEmbeddingRuntimeStartedMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createWithContentMock).toHaveBeenCalledTimes(1));
    expect(enqueueBackfillMock).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000101');
    expect(useWorkspaceCollectionSyncStatusStore.getState().managedCollectionName).toBe(
      'Managed Cache'
    );
  });

  it('stops and resets status when background indexing is disabled', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: false,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      hasHydrated: true,
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('disabled')
    );
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
  });

  it('passes the balanced indexing policy into the background sync request', async () => {
    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(readFullTreeWithOptionsMock).toHaveBeenCalledTimes(1));
    const options = readFullTreeWithOptionsMock.mock.calls[0]?.[2];
    expect(options?.entryPolicy).toBeDefined();
    expect(
      options?.entryPolicy?.shouldTraverseDirectory({
        directoryName: 'coverage',
        relativePath: 'coverage',
      })
    ).toBe(false);
    expect(
      options?.entryPolicy?.shouldIncludeFile({
        fileName: 'pnpm-lock.yaml',
        fileSize: 32,
        relativePath: 'pnpm-lock.yaml',
      })
    ).toBe(false);
  });

  it('waits for file explorer restoration to settle before starting background indexing', async () => {
    fileTreeContextState.current = {
      isRestorationSettled: false,
      isRestoringExpandedPaths: true,
      restorationProgress: null,
    };

    const { rerender } = render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('waiting')
    );
    expect(runEnhancedImportMock).not.toHaveBeenCalled();

    fileTreeContextState.current = {
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
    };
    rerender(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
  });

  it('waits for folder restore access loading to finish before starting background indexing', async () => {
    fileSystemState.isAccessLoading = true;

    const { rerender } = render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('waiting')
    );
    expect(runEnhancedImportMock).not.toHaveBeenCalled();

    fileSystemState.isAccessLoading = false;
    rerender(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
  });

  it('does not deadlock when the shared file tree context is unavailable', async () => {
    fileTreeContextState.current = null;

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
  });
});
