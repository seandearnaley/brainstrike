import type { EmbeddingSet, ManagedCacheEntryMetadata } from '@brainstrike/db';
import { generateContentHash } from '@brainstrike/utils';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceCollectionSyncService,
  type WorkspaceCollectionSyncServiceDependencies,
} from '../workspace-collection-sync-service';

const { readFullTreeWithOptionsMock, runEnhancedImportMock, createBrowserEmbeddingQueuePortMock } =
  vi.hoisted(() => ({
    readFullTreeWithOptionsMock: vi.fn(),
    runEnhancedImportMock: vi.fn(),
    createBrowserEmbeddingQueuePortMock: vi.fn(() => ({
      enqueueBatch: vi.fn(async () => {}),
      resetProgress: vi.fn(),
    })),
  }));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  readFullTreeWithOptions: readFullTreeWithOptionsMock,
}));

vi.mock('@brainstrike/file-import', () => ({
  createBrowserEmbeddingQueuePort: createBrowserEmbeddingQueuePortMock,
  runEnhancedImport: runEnhancedImportMock,
}));

function createCollection(overrides: Partial<EmbeddingSet> = {}): EmbeddingSet {
  return {
    id: overrides.id ?? 'set-1',
    name: overrides.name ?? 'Managed Cache',
    modelId: overrides.modelId ?? 'text-embedding-3-small',
    modelKey: overrides.modelKey ?? 'openai::text-embedding-3-small',
    dimensions: overrides.dimensions ?? 1536,
    distance: overrides.distance ?? 'cosine',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

function createDeps(
  overrides: Partial<WorkspaceCollectionSyncServiceDependencies> = {}
): WorkspaceCollectionSyncServiceDependencies {
  return {
    chunkRepository: {
      deleteByFileRecordId: vi.fn(async () => undefined),
      update: vi.fn(async () => null),
    },
    db: {
      query: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    } as unknown as WorkspaceCollectionSyncServiceDependencies['db'],
    embeddingDeviceHint: 'webgpu',
    embeddingSetsRepository: {
      getById: vi.fn(async () => createCollection()),
    } as unknown as WorkspaceCollectionSyncServiceDependencies['embeddingSetsRepository'],
    fileContentProcessor: {
      processFiles: vi.fn(),
    },
    fileRecordRepository: {
      createWithContent: vi.fn(async () => undefined),
      listManagedCacheEntryMetadata: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
    },
    fileSystemAdapter: {
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      exists: vi.fn(),
    },
    ensureChunkingWorker: vi.fn(async () => ({
      chunkBatch: vi.fn(),
      isReady: () => true,
      transportKind: 'local-worker' as const,
      chunkFile: vi.fn(),
      terminate: vi.fn(),
    })),
    loadEmbeddingQueue: vi.fn(async () => ({
      add: vi.fn(),
      addBulk: vi.fn(),
      cancel: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined),
      isPaused: false,
      isProcessing: false,
      onProgress: vi.fn(() => () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
    })),
    setImporting: vi.fn(),
    setStatus: vi.fn(),
    validateHostedProviderAccess: vi.fn(async () => undefined),
    validateLocalRuntime: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createRootHandle(path = '/workspace/root') {
  return {
    kind: 'directory' as const,
    name: 'workspace',
    path,
    platform: 'electron' as const,
  };
}

const ROOT_PATH = '/workspace/root';
const FILE_PATH = 'src/index.ts';
const COMPOSITE_KEY = encodeFileSelection(ROOT_PATH, FILE_PATH);

describe('WorkspaceCollectionSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        type: 'file',
        handle: { platform: 'electron', path: `${ROOT_PATH}/${FILE_PATH}` },
        rootFolderId: ROOT_PATH,
      },
    ]);
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

  it('does not start the local runtime when reconciliation finds no changes', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const fileContentProcessor = {
      processFiles: vi.fn(async () => ({
        [COMPOSITE_KEY]: unchangedContent,
      })),
    };
    const deps = createDeps({
      embeddingSetsRepository: {
        getById: vi.fn(async () =>
          createCollection({
            modelId: 'local-model',
            modelKey: 'local::local-model',
          })
        ),
      } as unknown as WorkspaceCollectionSyncServiceDependencies['embeddingSetsRepository'],
      fileContentProcessor,
      fileRecordRepository: {
        createWithContent: vi.fn(async () => undefined),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            fileRecordId: 'file-1',
            embeddingSetId: 'set-1',
            sourceRootPath: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: unchangedHash,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.validateLocalRuntime).not.toHaveBeenCalled();
    expect(deps.ensureChunkingWorker).not.toHaveBeenCalled();
    expect(deps.loadEmbeddingQueue).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'idle',
        processedFiles: 1,
      })
    );
  });

  it('clears stale chunk metadata before replacing an indexed file', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      fileRecordRepository: {
        createWithContent: vi.fn(async () => undefined),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            fileRecordId: 'file-1',
            embeddingSetId: 'set-1',
            sourceRootPath: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: 'old-hash',
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.ensureChunkingWorker).toHaveBeenCalledTimes(1);
    expect(deps.chunkRepository.deleteByFileRecordId).toHaveBeenCalledWith('file-1');
    expect(deps.fileRecordRepository.update).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        chunksCount: 0,
        chunksProcessedAt: undefined,
        embeddingSetId: 'set-1',
      })
    );
  });

  it('aborts in-flight import work when the sync is cancelled', async () => {
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
    });
    runEnhancedImportMock.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        startedResolve?.();
        await new Promise<never>((_, reject) => {
          abortSignal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        });
      }
    );
    const service = new WorkspaceCollectionSyncService(deps);

    const syncPromise = service.sync({
      enabled: true,
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });
    await started;
    service.cancel();

    await expect(syncPromise).resolves.toBeUndefined();
    expect(runEnhancedImportMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      })
    );
    expect(deps.setStatus).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
      })
    );
  });

  it('starts the chunking worker lazily when no current port snapshot exists', async () => {
    const chunkingWorkerPort = {
      isReady: () => true,
      transportKind: 'host-proxy' as const,
      chunkBatch: vi.fn(),
      chunkFile: vi.fn(),
      terminate: vi.fn(),
    };
    const deps = createDeps({
      ensureChunkingWorker: vi.fn(async () => chunkingWorkerPort),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.ensureChunkingWorker).toHaveBeenCalledTimes(1);
    expect(runEnhancedImportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chunking: expect.objectContaining({
          chunkingWorkerPort,
        }),
      })
    );
  });
});
