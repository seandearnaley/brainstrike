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
  ensureStartedMock,
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
  ensureStartedMock: vi.fn(),
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
    rootDirectoryHandle: {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    },
  }),
  readFullTreeWithOptions: readFullTreeWithOptionsMock,
}));

vi.mock('@brainstrike/file-import/chunking-worker-context', () => ({
  useChunkingWorkerContext: () => ({
    port: {
      isReady: () => true,
      transportKind: 'local',
    },
    ensureStarted: ensureStartedMock,
  }),
}));

vi.mock('@brainstrike/file-import', () => ({
  createBrowserEmbeddingQueuePort: vi.fn(() => ({
    enqueueBatch: vi.fn(async () => {}),
    resetProgress: vi.fn(),
  })),
  runEnhancedImport: runEnhancedImportMock,
}));

vi.mock('@brainstrike/vector-management', () => ({
  createVectorQueueService: vi.fn(() => ({
    validateApiKeyForSet: validateApiKeyForSetMock,
  })),
}));

describe('WorkspaceCollectionSyncProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();

    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
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
    ensureStartedMock.mockResolvedValue({
      isReady: () => true,
      transportKind: 'local',
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
      <WorkspaceCollectionSyncProvider
        loadEmbeddingQueue={async () => ({
          add: vi.fn(),
          addBulk: vi.fn(),
          onProgress: vi.fn(() => () => {}),
          pause: vi.fn(),
          resume: vi.fn(),
          drain: vi.fn(),
          cancel: vi.fn(),
          isPaused: false,
          isProcessing: false,
        })}
      >
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(ensureStartedMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createWithContentMock).toHaveBeenCalledTimes(1));
    expect(useWorkspaceCollectionSyncStatusStore.getState().managedCollectionName).toBe(
      'Managed Cache'
    );
  });

  it('stops and resets status when background indexing is disabled', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: false,
      managedCollectionId: null,
      mode: 'root-folder-cache',
      hasHydrated: true,
    });

    render(
      <WorkspaceCollectionSyncProvider
        loadEmbeddingQueue={async () => ({
          add: vi.fn(),
          addBulk: vi.fn(),
          onProgress: vi.fn(() => () => {}),
          pause: vi.fn(),
          resume: vi.fn(),
          drain: vi.fn(),
          cancel: vi.fn(),
          isPaused: false,
          isProcessing: false,
        })}
      >
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('disabled')
    );
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
  });
});
