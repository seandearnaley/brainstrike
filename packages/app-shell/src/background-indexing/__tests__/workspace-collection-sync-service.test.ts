import type { ManagedCacheEntryMetadata } from '@brainstrike/db';
import { generateContentHash } from '@brainstrike/utils';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/utils/workspace-indexing-qos';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceCollectionSyncService,
  type WorkspaceCollectionSyncServiceDependencies,
} from '../workspace-collection-sync-service';
import {
  BALANCED_QOS_POLICY,
  createCollection,
  createDeps,
  createRootHandle,
  FILE_PATH,
  ROOT_PATH,
} from './workspace-collection-sync-service-test-helpers';

const { readFullTreeWithOptionsMock, runEnhancedImportMock } = vi.hoisted(() => ({
  readFullTreeWithOptionsMock: vi.fn(),
  runEnhancedImportMock: vi.fn(),
}));

vi.mock('@brainstrike/file-explorer-ui/tree', () => ({
  readFullTreeWithOptions: readFullTreeWithOptionsMock,
}));

vi.mock('@brainstrike/file-import', () => ({
  backfillEmbeddingSetAssignments: vi.fn(async () => undefined),
  runEnhancedImport: runEnhancedImportMock,
}));
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
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
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

  it('waits and retries when startup QoS temporarily yields scan work to foreground DB pressure', async () => {
    const foregroundYieldPolicy: WorkspaceIndexingQosPolicy = {
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      interBatchDelayMs: 250,
      progressThrottleMs: 500,
      reason: 'foreground-db-pressure',
      scanBatchSize: 0,
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    };
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      resolveQosPolicy: vi
        .fn()
        .mockResolvedValueOnce(foregroundYieldPolicy)
        .mockResolvedValueOnce(foregroundYieldPolicy)
        .mockResolvedValueOnce(foregroundYieldPolicy)
        .mockResolvedValue(BALANCED_QOS_POLICY),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.waitForBackgroundPermit).toHaveBeenCalledWith({
      label: 'Workspace Index scan',
    });
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'waiting',
        lastError: null,
      })
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: 'Workspace Index QoS policy does not permit scan work.',
      })
    );
    expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);
  });

  it('backs off before re-resolving foreground-yielding QoS when the permit returns immediately', async () => {
    vi.useFakeTimers();
    const foregroundYieldPolicy: WorkspaceIndexingQosPolicy = {
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      interBatchDelayMs: 25,
      progressThrottleMs: 500,
      reason: 'foreground-db-pressure',
      scanBatchSize: 0,
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    };
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 3;',
        })),
      },
      resolveQosPolicy: vi
        .fn()
        .mockResolvedValueOnce(foregroundYieldPolicy)
        .mockResolvedValue(BALANCED_QOS_POLICY),
      waitForBackgroundPermit: vi.fn(async () => undefined),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    try {
      const syncPromise = service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
      }

      expect(deps.waitForBackgroundPermit).toHaveBeenCalledWith({
        label: 'Workspace Index scan',
      });
      expect(deps.resolveQosPolicy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(24);
      expect(deps.resolveQosPolicy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await syncPromise;
      expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);
      expect(deps.resolveQosPolicy).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not surface an error when QoS changes to paused while waiting for scan work', async () => {
    const foregroundYieldPolicy: WorkspaceIndexingQosPolicy = {
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      interBatchDelayMs: 250,
      progressThrottleMs: 500,
      reason: 'foreground-db-pressure',
      scanBatchSize: 0,
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    };
    const pausedPolicy: WorkspaceIndexingQosPolicy = {
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      interBatchDelayMs: 1000,
      progressThrottleMs: 1000,
      reason: 'manual-paused',
      scanBatchSize: 0,
      state: 'paused',
      workerClaimBatchSize: 0,
    };
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as NonNullable<WorkspaceCollectionSyncServiceDependencies['log']>;
    const deps = createDeps({
      log,
      resolveQosPolicy: vi
        .fn()
        .mockResolvedValueOnce(foregroundYieldPolicy)
        .mockResolvedValue(pausedPolicy),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.waitForBackgroundPermit).toHaveBeenCalledWith({
      label: 'Workspace Index scan',
    });
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: 'Workspace Index QoS policy does not permit scan work.',
      })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('resumes backfill when files are unchanged but embedding coverage is incomplete', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: unchangedContent,
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
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
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          totalChunks: 10,
          chunksWithEmbeddingsForSet: 1,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
      getBackfillsInFlight: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      subscribeToBackfillProgress: vi.fn((callback) => {
        callback({
          embeddingSetId: 'set-1',
          requestId: 'background-indexing-backfill:test',
          current: 3,
          total: 10,
          message: 'chunk 3/10',
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

    expect(deps.ensureEmbeddingRuntimeStarted).toHaveBeenCalledTimes(1);
    expect(deps.enqueueBackfill).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        source: 'background-indexing',
      })
    );
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'embedding',
        embeddingProgress: expect.objectContaining({
          chunksProcessed: 3,
          totalChunks: 10,
        }),
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'idle',
        scanSummary: expect.objectContaining({
          unchangedFiles: 1,
          changedFiles: 0,
        }),
      })
    );
  });

  it('clears stale embedding and queue progress when entering the pending embedding state', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: unchangedContent,
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
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
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          totalChunks: 10,
          chunksWithEmbeddingsForSet: 1,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
      subscribeToBackfillProgress: vi.fn(() => () => {}),
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
        embeddingProgress: null,
        queueProgress: null,
      })
    );
  });

  it('returns without transitioning to idle when the unchanged-files backfill path is cancelled after enqueueing', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: unchangedContent,
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
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
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          totalChunks: 10,
          chunksWithEmbeddingsForSet: 1,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);
    vi.mocked(deps.enqueueBackfill).mockImplementationOnce(async () => {
      await service.cancel();
      return { requestId: 'background-indexing-backfill:test' };
    });

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.enqueueBackfill).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        source: 'background-indexing',
      })
    );
    expect(deps.setStatus).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'idle',
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

  it('propagates scan and content-processing progress through the status reporter', async () => {
    readFullTreeWithOptionsMock.mockImplementationOnce(async (_adapter, _handle, options) => {
      options?.updateProgress?.();
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
        processFiles: vi.fn(async (requests, onProgress) => {
          const firstRequest = requests[0];
          if (!firstRequest) {
            throw new Error('Expected one file request.');
          }
          onProgress({ key: firstRequest.compositeKey });
          return {
            [firstRequest.compositeKey]: 'export const value = 1;',
          };
        }),
      },
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
        currentFilePath: null,
      })
    );
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        currentFilePath: FILE_PATH,
      })
    );
  });

  it('does not treat legitimate file content containing error marker text as inaccessible', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]:
            'export const marker = "Binary file - preview not available"; export const ok = true;',
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

    expect(deps.applyManagedCacheBatch).toHaveBeenCalledTimes(1);
    expect(deps.waitForBackgroundPermit).toHaveBeenCalledWith({
      label: 'background import batch',
    });
    expect(deps.waitForBackgroundPermit).toHaveBeenCalledWith({
      label: 'background import assignment',
    });
    expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);
  });

  it('does not persist files whose second read resolves to an inaccessible marker value', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi
          .fn()
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: 'export const value = 1;',
          })
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: 'Binary file - preview not available',
          }),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
    expect(deps.fileRecordRepository.update).not.toHaveBeenCalled();
    expect(deps.enqueueBackfill).toHaveBeenCalledTimes(1);
  });

  it('reports a selected file as failed when the import batch is missing its content payload', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi
          .fn()
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: 'export const value = 1;',
          })
          .mockResolvedValueOnce({}),
      },
    });
    let importResults: Array<{ error?: string; id: string; imported: boolean }> = [];
    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      importResults = await params.baseImportRunner({
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

    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
    expect(importResults).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        imported: false,
        error: 'Background cache import descriptor is missing.',
      }),
    ]);
  });

  it('recomputes the persisted content hash from the import-time file payload', async () => {
    const initialContent = 'export const version = 1;';
    const importTimeContent = 'export const version = 2;';
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi
          .fn()
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: initialContent,
          })
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: importTimeContent,
          }),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingSetId: 'set-1',
        changes: [
          expect.objectContaining({
            mode: 'import',
            record: expect.objectContaining({
              content: importTimeContent,
              contentHash: await generateContentHash(importTimeContent),
            }),
          }),
        ],
      })
    );
  });

  it('uses one createdAt timestamp for all imports in the same managed-cache batch', async () => {
    const secondFilePath = 'src/utils.ts';
    const secondCompositeKey = encodeFileSelection(ROOT_PATH, secondFilePath);
    readFullTreeWithOptionsMock.mockResolvedValueOnce([
      {
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        type: 'file',
        handle: { platform: 'electron', path: `${ROOT_PATH}/${FILE_PATH}` },
        rootFolderId: ROOT_PATH,
      },
      {
        name: 'utils.ts',
        path: '/workspace/root/src/utils.ts',
        type: 'file',
        handle: { platform: 'electron', path: `${ROOT_PATH}/${secondFilePath}` },
        rootFolderId: ROOT_PATH,
      },
    ]);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi
          .fn()
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: 'export const indexValue = 1;',
            [secondCompositeKey]: 'export const utilValue = 2;',
          })
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: 'export const indexValue = 1;',
            [secondCompositeKey]: 'export const utilValue = 2;',
          }),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.applyManagedCacheBatch).toHaveBeenCalledTimes(1);
    const batchArgs = vi.mocked(deps.applyManagedCacheBatch).mock.calls[0]?.[0];
    expect(batchArgs).toBeDefined();
    const importChanges =
      batchArgs?.changes.filter(
        (change): change is Extract<(typeof batchArgs.changes)[number], { mode: 'import' }> =>
          change.mode === 'import'
      ) ?? [];
    expect(importChanges).toHaveLength(2);
    expect(new Set(importChanges.map((change) => change.record.createdAt)).size).toBe(1);
  });

  it('swallows abort errors raised during the sync pass without reporting a failure', async () => {
    const abortError = new Error('Synthetic abort');
    abortError.name = 'AbortError';
    readFullTreeWithOptionsMock.mockRejectedValueOnce(abortError);
    const deps = createDeps();
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'error',
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
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
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
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingSetId: 'set-1',
        changes: [
          expect.objectContaining({
            mode: 'replace',
            record: expect.objectContaining({
              id: 'file-1',
              path: FILE_PATH,
              sourceRootPath: ROOT_PATH,
            }),
          }),
        ],
      })
    );
    expect(deps.chunkRepository.deleteByFileRecordId).not.toHaveBeenCalled();
    expect(deps.fileRecordRepository.update).not.toHaveBeenCalled();
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

  it('checks managed backfill in-flight state again after enqueueing before transitioning to idle', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      getBackfillsInFlight: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      subscribeToBackfillProgress: vi.fn((callback) => {
        callback({
          embeddingSetId: 'set-1',
          requestId: 'background-indexing-backfill:test',
          current: 1,
          total: 3,
          message: 'chunk 1/3',
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

    expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(2);
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'embedding',
        backfillRequestId: 'background-indexing-backfill:test',
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'idle',
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

  it('re-checks cancellation before applying a batched managed-cache mutation', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      const selectedFilePaths = {
        size: 1,
        has: (key: string) => {
          if (key === COMPOSITE_KEY) {
            void service.cancel();
          }
          return true;
        },
      } as unknown as Set<string>;

      await params.baseImportRunner({
        selectedFilePaths,
        fileTree: params.request.fileTree,
        fileContents: params.request.fileContents,
        onProgress: () => {},
      });
      return [];
    });

    await expect(
      service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      })
    ).resolves.toBeUndefined();

    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
    expect(deps.enqueueBackfill).not.toHaveBeenCalled();
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
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
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

  it('times out when an attached backfill never drains', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps({
        backfillDrainTimeoutMs: 500,
        getBackfillsInFlight: vi.fn(async () => [
          {
            embeddingSetId: 'set-1',
            requestId: 'background-indexing-backfill:test',
            progress: { current: 1, total: 4 },
          },
        ]),
      });
      const service = new WorkspaceCollectionSyncService(deps) as unknown as {
        waitForBackfillToDrain: (args: {
          abortSignal: AbortSignal;
          collectionId: string;
          requestId: string;
        }) => Promise<void>;
      };
      const abortController = new AbortController();

      const drainPromise = service.waitForBackfillToDrain({
        abortSignal: abortController.signal,
        collectionId: 'set-1',
        requestId: 'background-indexing-backfill:test',
      });
      const drainExpectation = expect(drainPromise).rejects.toThrow(
        'Timed out waiting for background indexing backfill to drain for collection set-1.'
      );

      await vi.advanceTimersByTimeAsync(1000);

      await drainExpectation;
    } finally {
      vi.useRealTimers();
    }
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
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledTimes(2);
    expect(batchSizes.every((size) => size <= 24)).toBe(true);
  });

  it('backs off drain polling instead of polling at a fixed interval', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps({
        getBackfillsInFlight: vi
          .fn()
          .mockResolvedValueOnce([
            {
              embeddingSetId: 'set-1',
              requestId: 'background-indexing-backfill:test',
              progress: { current: 1, total: 4 },
            },
          ])
          .mockResolvedValueOnce([
            {
              embeddingSetId: 'set-1',
              requestId: 'background-indexing-backfill:test',
              progress: { current: 2, total: 4 },
            },
          ])
          .mockResolvedValueOnce([
            {
              embeddingSetId: 'set-1',
              requestId: 'background-indexing-backfill:test',
              progress: { current: 3, total: 4 },
            },
          ])
          .mockResolvedValueOnce([]),
      });
      const service = new WorkspaceCollectionSyncService(deps) as unknown as {
        waitForBackfillToDrain: (args: {
          abortSignal: AbortSignal;
          collectionId: string;
          requestId: string;
        }) => Promise<void>;
      };
      const abortController = new AbortController();

      const drainPromise = service.waitForBackfillToDrain({
        abortSignal: abortController.signal,
        collectionId: 'set-1',
        requestId: 'background-indexing-backfill:test',
      });

      expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(999);
      expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      await drainPromise;
      expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the last import/chunk summary when no explicit complete progress event is emitted', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
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
          chunksCreated: 2,
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

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        importProgress: expect.objectContaining({
          completed: 1,
          total: 1,
        }),
        chunkingProgress: expect.objectContaining({
          filesProcessed: 1,
          chunksCreated: 2,
        }),
        scanSummary: expect.objectContaining({
          changedFiles: 1,
        }),
      })
    );
  });

  it('surfaces a terminal error when sync work fails after scanning has started', async () => {
    const deps = createDeps({
      ensureChunkingWorker: vi.fn(async () => {
        throw new Error('Chunking worker failed to start');
      }),
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

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        lastError: 'Chunking worker failed to start',
      })
    );
  });

  it('surfaces invalid managed-collection metadata before scanning proceeds', async () => {
    const deps = createDeps({
      embeddingSetsRepository: {
        getById: vi.fn(async () =>
          createCollection({
            modelId: '',
            modelKey: '',
            dimensions: 0,
          })
        ),
      } as unknown as WorkspaceCollectionSyncServiceDependencies['embeddingSetsRepository'],
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        lastError: 'Managed collection metadata is invalid.',
      })
    );
    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
  });

  it('clears stale managed-collection ids when the configured collection no longer exists', async () => {
    const onManagedCollectionMissing = vi.fn();
    const deps = createDeps({
      embeddingSetsRepository: {
        getById: vi.fn(async () => null),
      } as unknown as WorkspaceCollectionSyncServiceDependencies['embeddingSetsRepository'],
      onManagedCollectionMissing,
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-stale',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(onManagedCollectionMissing).toHaveBeenCalledWith('set-stale');
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        managedCollectionId: 'set-stale',
        lastError: 'Managed collection was not found. Select a new collection in Settings.',
      })
    );
    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
  });

  it('fails cleanly when hosted provider access validation rejects', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      validateHostedProviderAccess: vi.fn(async () => {
        throw new Error('Hosted provider API key is missing');
      }),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        lastError: 'Hosted provider API key is missing',
      })
    );
    expect(deps.ensureEmbeddingRuntimeStarted).not.toHaveBeenCalled();
  });

  it('skips hosted-provider validation for local collections and starts the runtime directly', async () => {
    const deps = createDeps({
      embeddingSetsRepository: {
        getById: vi.fn(async () =>
          createCollection({
            modelId: 'local-model',
            modelKey: 'local::local-model',
          })
        ),
      } as unknown as WorkspaceCollectionSyncServiceDependencies['embeddingSetsRepository'],
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

    expect(deps.validateHostedProviderAccess).not.toHaveBeenCalled();
    expect(deps.ensureEmbeddingRuntimeStarted).toHaveBeenCalledTimes(1);
  });

  it('returns early when the sync is cancelled immediately after context resolution', async () => {
    const deps = createDeps();
    const service = new WorkspaceCollectionSyncService({
      ...deps,
      embeddingSetsRepository: {
        getById: vi.fn(async () => {
          await service.cancel();
          return createCollection();
        }),
      } as unknown as WorkspaceCollectionSyncServiceDependencies['embeddingSetsRepository'],
    });

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
    expect(deps.enqueueBackfill).not.toHaveBeenCalled();
  });

  it('surfaces a recovery failure when an attached backfill never drains during sync', async () => {
    vi.useFakeTimers();
    try {
      const unchangedContent = 'export const value = 1;';
      const unchangedHash = await generateContentHash(unchangedContent);
      const deps = createDeps({
        backfillDrainTimeoutMs: 500,
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: unchangedContent,
          })),
        },
        fileRecordRepository: {
          findById: vi.fn(async () => null),
          findByIds: vi.fn(async () => []),
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
        getBackfillsInFlight: vi.fn(async () => [
          {
            embeddingSetId: 'set-1',
            requestId: 'background-indexing-backfill:test',
            progress: { current: 1, total: 4 },
          },
        ]),
      });
      const service = new WorkspaceCollectionSyncService(deps);

      const syncPromise = service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });

      await vi.advanceTimersByTimeAsync(1000);
      await syncPromise;

      expect(deps.setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: 'error',
          lastError:
            'Timed out waiting for background indexing backfill to drain for collection set-1.',
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels superseded background-indexing backfills for other collections before syncing the managed collection', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      getBackfillsInFlight: vi.fn(async () => [
        {
          embeddingSetId: 'set-2',
          requestId: 'background-indexing-backfill:stale',
          progress: { current: 1, total: 2 },
        },
      ]),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.cancelBackfill).toHaveBeenCalledWith('set-2');
    expect(deps.enqueueBackfill).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        source: 'background-indexing',
      })
    );
  });

  it('returns early when the run is superseded while canceling stale background backfills', async () => {
    const deps = createDeps({
      getBackfillsInFlight: vi.fn(async () => [
        {
          embeddingSetId: 'set-2',
          requestId: 'background-indexing-backfill:stale',
          progress: { current: 1, total: 2 },
        },
      ]),
    });
    const service = new WorkspaceCollectionSyncService(deps);
    vi.mocked(deps.cancelBackfill).mockImplementationOnce(async () => {
      await service.cancel();
    });

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.cancelBackfill).toHaveBeenCalledWith('set-2');
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.enqueueBackfill).not.toHaveBeenCalled();
  });

  it('returns without transitioning to idle when the run is cancelled immediately after enqueueing backfill', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);
    vi.mocked(deps.enqueueBackfill).mockImplementationOnce(async () => {
      await service.cancel();
      return { requestId: 'background-indexing-backfill:test' };
    });

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.enqueueBackfill).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        source: 'background-indexing',
      })
    );
    expect(deps.setStatus).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'idle',
      })
    );
  });

  it('ignores unrelated backfill progress events while tracking the managed collection request', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      subscribeToBackfillProgress: vi.fn((callback) => {
        callback({
          embeddingSetId: 'set-2',
          requestId: 'background-indexing-backfill:other',
          current: 9,
          total: 9,
          message: 'wrong collection',
        });
        callback({
          embeddingSetId: 'set-1',
          requestId: 'background-indexing-backfill:test',
          current: 1,
          total: 2,
          message: 'chunk 1/2',
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
        state: 'embedding',
        managedCollectionId: 'set-1',
        embeddingProgress: expect.objectContaining({
          chunksProcessed: 1,
          totalChunks: 2,
        }),
      })
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        currentFilePath: 'wrong collection',
        managedCollectionId: 'set-2',
      })
    );
  });
});
