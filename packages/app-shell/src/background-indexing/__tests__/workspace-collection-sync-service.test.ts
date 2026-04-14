import type { EmbeddingSet, ManagedCacheEntryMetadata } from '@brainstrike/db';
import { generateContentHash } from '@brainstrike/utils';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceCollectionSyncService,
  type WorkspaceCollectionSyncServiceDependencies,
} from '../workspace-collection-sync-service';

const { readFullTreeWithOptionsMock, runEnhancedImportMock } = vi.hoisted(() => ({
  readFullTreeWithOptionsMock: vi.fn(),
  runEnhancedImportMock: vi.fn(),
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  readFullTreeWithOptions: readFullTreeWithOptionsMock,
}));

vi.mock('@brainstrike/file-import', () => ({
  backfillEmbeddingSetAssignments: vi.fn(async () => undefined),
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
    },
    cancelBackfill: vi.fn(async () => undefined),
    db: {
      query: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    } as unknown as WorkspaceCollectionSyncServiceDependencies['db'],
    embeddingSetsRepository: {
      getById: vi.fn(async () => createCollection()),
    } as unknown as WorkspaceCollectionSyncServiceDependencies['embeddingSetsRepository'],
    enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
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
    getBackfillsInFlight: vi.fn(async () => []),
    ensureChunkingWorker: vi.fn(async () => ({
      chunkBatch: vi.fn(),
      isReady: () => true,
      transportKind: 'local-worker' as const,
      chunkFile: vi.fn(),
      terminate: vi.fn(),
    })),
    ensureEmbeddingRuntimeStarted: vi.fn(async () => undefined),
    setImporting: vi.fn(),
    setStatus: vi.fn(),
    subscribeToBackfillProgress: vi.fn(() => () => {}),
    validateHostedProviderAccess: vi.fn(async () => undefined),
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
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.ensureEmbeddingRuntimeStarted).not.toHaveBeenCalled();
    expect(deps.ensureChunkingWorker).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'idle',
        processedFiles: 1,
      })
    );
  });

  it('tracks policy-filtered entries in the scan summary', async () => {
    readFullTreeWithOptionsMock.mockImplementationOnce(async (_adapter, _handle, options) => {
      options?.onEntrySkipped?.({
        entryType: 'directory',
        reason: 'entry-policy',
        relativePath: 'coverage',
      });
      return [
        {
          name: 'index.ts',
          path: '/workspace/root/src/index.ts',
          type: 'file',
          handle: { platform: 'electron', path: `${ROOT_PATH}/${FILE_PATH}` },
          rootFolderId: ROOT_PATH,
        },
      ];
    });
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 1;',
        })),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(readFullTreeWithOptionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        entryPolicy: expect.any(Object),
        onEntrySkipped: expect.any(Function),
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scanSummary: expect.objectContaining({
          excludedEntries: 1,
        }),
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
      indexingPolicyPreset: 'balanced',
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

  it('imports with collection-assignment semantics and then backfills through the runtime pipeline', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.ensureEmbeddingRuntimeStarted).toHaveBeenCalledTimes(1);
    expect(runEnhancedImportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        embedding: expect.objectContaining({
          enabled: false,
          resolveTargetEmbeddingSetId: expect.any(Function),
        }),
      })
    );
    expect(deps.enqueueBackfill).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        source: 'background-indexing',
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
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });
    await started;
    await service.cancel();

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
      indexingPolicyPreset: 'balanced',
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

  it('preserves detailed scan, chunking, embedding, and queue telemetry through idle completion', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
      subscribeToBackfillProgress: vi.fn((callback) => {
        queueMicrotask(() => {
          callback({
            embeddingSetId: 'set-1',
            requestId: 'background-indexing-backfill:test',
            current: 2,
            total: 3,
            message: 'chunk 2/3',
          });
          callback({
            embeddingSetId: 'set-1',
            requestId: 'background-indexing-backfill:test',
            current: 3,
            total: 3,
            message: 'chunk 3/3',
          });
        });
        return () => {};
      }),
    });
    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      params.progressHandlers.emit?.({
        phase: 'chunking',
        total: 1,
        completed: 1,
        current: 'src/index.ts',
        errors: [],
        chunkingProgress: {
          filesProcessed: 1,
          totalFiles: 1,
          currentFile: 'src/index.ts',
          chunksCreated: 3,
          strategyUsed: 'sentence',
        },
      });
      params.progressHandlers.emit?.({
        phase: 'complete',
        total: 1,
        completed: 1,
        current: 'src/index.ts',
        errors: [],
        chunkingProgress: {
          filesProcessed: 1,
          totalFiles: 1,
          currentFile: 'src/index.ts',
          chunksCreated: 3,
          strategyUsed: 'sentence',
        },
      });
      return [];
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'embedding',
        chunkingProgress: expect.objectContaining({
          filesProcessed: 1,
          totalFiles: 1,
          chunksCreated: 3,
        }),
        embeddingProgress: expect.objectContaining({
          chunksProcessed: 3,
          totalChunks: 3,
          modelName: 'text-embedding-3-small',
        }),
        queueProgress: expect.objectContaining({
          processed: 3,
          pending: 0,
          totalQueued: 3,
        }),
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'idle',
        scanSummary: {
          discoveredFiles: 1,
          changedFiles: 1,
          excludedEntries: 0,
          unchangedFiles: 0,
        },
        processedFiles: 1,
        queuedFiles: 0,
      })
    );
  });

  it('cancels an in-flight managed backfill when background indexing is disabled', async () => {
    let rejectBackfill: ((error: unknown) => void) | null = null;
    let resolveBackfillStarted: (() => void) | null = null;
    const backfillStarted = new Promise<void>((resolve) => {
      resolveBackfillStarted = resolve;
    });
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      enqueueBackfill: vi.fn(async (_embeddingSetId, options): Promise<{ requestId: string }> => {
        expect(options.source).toBe('background-indexing');
        resolveBackfillStarted?.();
        await new Promise<never>((_, reject) => {
          rejectBackfill = reject;
        });
        return { requestId: 'background-indexing-backfill:test' };
      }),
    });
    const service = new WorkspaceCollectionSyncService(deps);
    vi.mocked(deps.cancelBackfill).mockImplementationOnce(async () => {
      const error = new Error('Embedding backfill was canceled.');
      error.name = 'AbortError';
      rejectBackfill?.(error);
    });

    const firstSync = service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });
    await backfillStarted;

    await service.sync({
      enabled: false,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    await expect(firstSync).resolves.toBeUndefined();
    expect(deps.cancelBackfill).toHaveBeenCalledWith('set-1');
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'disabled',
      })
    );
  });

  it('enters recovering state when the managed collection already has an in-flight backfill', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: unchangedContent,
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
            contentHash: unchangedHash,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
      },
      getBackfillsInFlight: vi
        .fn()
        .mockResolvedValueOnce([
          {
            embeddingSetId: 'set-1',
            requestId: 'background-indexing-backfill:test',
            progress: { current: 2, total: 4 },
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      subscribeToBackfillProgress: vi.fn((callback) => {
        callback({
          embeddingSetId: 'set-1',
          requestId: 'background-indexing-backfill:test',
          current: 3,
          total: 4,
          message: 'chunk 3/4',
        });
        return () => {};
      }),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'recovering',
        backfillRequestId: 'background-indexing-backfill:test',
      })
    );
    expect(deps.enqueueBackfill).not.toHaveBeenCalled();
  });

  it('imports changed files in bounded batches instead of building a single full-run content map', async () => {
    const fileNodes = Array.from({ length: 30 }, (_, index) => ({
      name: `file-${index}.ts`,
      path: `${ROOT_PATH}/src/file-${index}.ts`,
      type: 'file' as const,
      handle: { platform: 'electron', path: `${ROOT_PATH}/src/file-${index}.ts` },
      rootFolderId: ROOT_PATH,
    }));
    readFullTreeWithOptionsMock.mockResolvedValueOnce(fileNodes);
    const batchSizes: number[] = [];
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async (requests: Array<{ compositeKey: string }>) => {
          batchSizes.push(requests.length);
          return Object.fromEntries(
            requests.map((request, index) => [
              request.compositeKey,
              `export const value${index} = ${index};`,
            ])
          );
        }),
      },
    });
    runEnhancedImportMock.mockImplementation(async (params) => {
      expect(Object.keys(params.request.fileContents).length).toBeLessThanOrEqual(24);
      await params.baseImportRunner({
        selectedFilePaths: params.request.selectedFilePaths,
        fileTree: params.request.fileTree,
        fileContents: params.request.fileContents,
        onProgress: () => {},
      });
      return [];
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(runEnhancedImportMock).toHaveBeenCalledTimes(2);
    expect(batchSizes.every((size) => size <= 24)).toBe(true);
  });
});
