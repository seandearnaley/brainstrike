import type { ManagedCacheEntryMetadata } from '@brainstrike/db';
import type { IFileNode } from '@brainstrike/types';
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
const ROOT_B_PATH = '/workspace/root-b';
const DB_ROOT_A_ID = 'db-root-a';
const DB_ROOT_B_ID = 'db-root-b';
const ROOT_B_COMPOSITE_KEY = encodeFileSelection(ROOT_B_PATH, FILE_PATH);

function createTestQosPolicy(
  policy: Omit<
    WorkspaceIndexingQosPolicy,
    | 'completionOverlapBatches'
    | 'maxPendingCompletionBytes'
    | 'maxPendingCompletionChunks'
    | 'streamBatchSize'
  >
): WorkspaceIndexingQosPolicy {
  return {
    completionOverlapBatches: 1,
    maxPendingCompletionBytes: 3072,
    maxPendingCompletionChunks: 1,
    streamBatchSize: 1,
    ...policy,
  };
}

function createMockNodeHandle(args: {
  kind: 'directory' | 'file';
  name: string;
  path: string;
}): IFileNode['handle'] {
  return {
    kind: args.kind,
    name: args.name,
    path: args.path,
    platform: 'electron',
  } as unknown as IFileNode['handle'];
}

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
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: unchangedHash,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      fileSystemAdapter: {
        readDirectory: vi.fn(
          async (): Promise<IFileNode[]> => [
            {
              depth: 1,
              handle: createMockNodeHandle({
                kind: 'file',
                name: 'index.ts',
                path: `${ROOT_PATH}/${FILE_PATH}`,
              }),
              lastModified: 1000,
              name: 'index.ts',
              path: `${ROOT_PATH}/${FILE_PATH}`,
              rootFolderId: ROOT_PATH,
              selectionState: 'unchecked',
              size: 23,
              type: 'file',
            },
          ]
        ),
        readFile: vi.fn(),
        requestDirectoryAccess: vi.fn(),
        exists: vi.fn(),
      } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'],
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
    const foregroundYieldPolicy = createTestQosPolicy({
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
    });
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
    const foregroundYieldPolicy = createTestQosPolicy({
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
    });
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

  it('requests the foreground-db-pressure bypass and proceeds once a sync phase is starved past the bound', async () => {
    vi.useFakeTimers();
    const foregroundYieldPolicy = createTestQosPolicy({
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
    });
    // The resolver downgrades foreground-db-pressure to workable, constrained
    // work ONLY when the starvation bypass is requested — mirroring the real
    // resolveWorkspaceIndexingQosPolicy behaviour.
    let starvationBypassRequested = false;
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 7;',
        })),
      },
      resolveQosPolicy: vi.fn(
        async (options?: { foregroundDbPressureStarvationBypass?: boolean }) => {
          if (options?.foregroundDbPressureStarvationBypass) {
            starvationBypassRequested = true;
            return BALANCED_QOS_POLICY;
          }
          return starvationBypassRequested ? BALANCED_QOS_POLICY : foregroundYieldPolicy;
        }
      ),
      waitForBackgroundPermit: vi.fn(async () => undefined),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    try {
      let settled = false;
      const syncPromise = service
        .sync({
          enabled: true,
          indexingPolicyPreset: 'balanced',
          managedCollectionId: 'set-1',
          rootDirectoryHandle: createRootHandle(ROOT_PATH),
        })
        .finally(() => {
          settled = true;
        });
      // Step fake time forward (the loop re-resolves every interBatchDelayMs)
      // until the starved phases cross the 5s bound and the sync completes.
      for (let step = 0; step < 400 && !settled; step += 1) {
        await vi.advanceTimersByTimeAsync(250);
      }
      await syncPromise;

      // The starved pass must have requested the bypass and then completed the
      // import instead of yielding forever.
      expect(deps.resolveQosPolicy).toHaveBeenCalledWith({
        foregroundDbPressureStarvationBypass: true,
      });
      expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('does not surface an error when QoS changes to paused while waiting for scan work', async () => {
    const foregroundYieldPolicy = createTestQosPolicy({
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
    });
    const pausedPolicy = createTestQosPolicy({
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
    });
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

  it('treats unexpected non-permitting QoS states as a graceful pause before scan work', async () => {
    const nonPermittingPolicy: WorkspaceIndexingQosPolicy = {
      ...BALANCED_QOS_POLICY,
      allowNewWork: false,
      state: 'balanced',
    };
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as NonNullable<WorkspaceCollectionSyncServiceDependencies['log']>;
    const deps = createDeps({
      log,
      resolveQosPolicy: vi.fn().mockResolvedValue(nonPermittingPolicy),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
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
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: unchangedHash,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
      getBackfillsInFlight: vi.fn().mockResolvedValueOnce([]),
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
        state: 'embedding',
        backfillRequestId: 'background-indexing-backfill:test',
        scanSummary: expect.objectContaining({
          unchangedFiles: 1,
          changedFiles: 0,
        }),
      })
    );
  });

  it('persists stat refreshes so hash-unchanged pre-migration rows join the stat-cache', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        type: 'file',
        handle: { platform: 'electron', path: `${ROOT_PATH}/${FILE_PATH}` },
        rootFolderId: ROOT_PATH,
        size: 42,
        lastModified: 1000,
      },
    ]);
    const updateStatMetadata = vi.fn(async () => undefined);
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
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: unchangedHash,
            // Pre-migration row: no stored stats yet.
            mtimeMs: null,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata,
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(updateStatMetadata).toHaveBeenCalledWith([
      { fileRecordId: 'file-1', mtimeMs: 1000, size: 42 },
    ]);
  });

  it('re-enqueues the backfill for stat-skipped files whose embeddings are missing, without reading them', async () => {
    // The stat-cache residual must never compound into missing embeddings: a
    // file skipped by the size+mtime fast-path (never read, never hashed) with
    // incomplete embedding coverage still reaches the coverage check and gets
    // its backfill re-enqueued. processFiles throws to prove no read happens.
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        type: 'file',
        handle: { platform: 'electron', path: `${ROOT_PATH}/${FILE_PATH}` },
        rootFolderId: ROOT_PATH,
        size: 42,
        lastModified: 1000,
      },
    ]);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => {
          throw new Error('Stat-skipped files must not be read.');
        }),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            fileRecordId: 'file-1',
            embeddingSetId: 'set-1',
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            // Deliberately NOT the file's real hash: proves the skip is purely
            // stat-based and the coverage path is independent of content reads.
            contentHash: 'hash-never-consulted',
            mtimeMs: 1000,
            size: 42,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.fileContentProcessor?.processFiles).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.enqueueBackfill).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        source: 'background-indexing',
      })
    );
  });

  it('defers collection-wide backfill when an intermediate root has missing embeddings', async () => {
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        type: 'file',
        handle: { platform: 'electron', path: `${ROOT_PATH}/${FILE_PATH}` },
        rootFolderId: ROOT_PATH,
        size: 42,
        lastModified: 1000,
      },
    ]);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => {
          throw new Error('Stat-skipped files must not be read.');
        }),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            fileRecordId: 'file-1',
            embeddingSetId: 'set-1',
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: 'hash-never-consulted',
            mtimeMs: 1000,
            size: 42,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
      getBackfillsInFlight: vi.fn().mockResolvedValueOnce([]),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      backfillMode: 'defer',
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.fileContentProcessor?.processFiles).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.ensureEmbeddingRuntimeStarted).not.toHaveBeenCalled();
    expect(deps.enqueueBackfill).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'idle',
        processedFiles: 1,
        queuedFiles: 0,
      })
    );
  });

  it('reprocesses stat-matching files whose prior import never completed chunking', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        type: 'file',
        handle: { platform: 'electron', path: `${ROOT_PATH}/${FILE_PATH}` },
        rootFolderId: ROOT_PATH,
        size: 42,
        lastModified: 1000,
      },
    ]);
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
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: unchangedHash,
            chunksCount: 0,
            chunksProcessedAt: null,
            mtimeMs: 1000,
            size: 42,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.fileContentProcessor?.processFiles).toHaveBeenCalled();
    expect(runEnhancedImportMock).toHaveBeenCalledOnce();
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        rootId: ROOT_PATH,
        changes: [
          expect.objectContaining({
            mode: 'replace',
            record: expect.objectContaining({
              id: 'file-1',
              path: FILE_PATH,
              content: unchangedContent,
            }),
          }),
        ],
      })
    );
  });

  it('force-reads a watcher-modified file and replaces only the matching db root identity', async () => {
    const oldContent = 'export const value = 1;';
    const newContent = 'export const value = 2;';
    const oldHash = await generateContentHash(oldContent);
    const fileSystemAdapter = {
      readDirectory: vi.fn(
        async (): Promise<IFileNode[]> => [
          {
            depth: 1,
            handle: createMockNodeHandle({
              kind: 'file',
              name: 'index.ts',
              path: `${ROOT_B_PATH}/${FILE_PATH}`,
            }),
            lastModified: 1000,
            name: 'index.ts',
            path: `${ROOT_B_PATH}/${FILE_PATH}`,
            rootFolderId: ROOT_B_PATH,
            selectionState: 'unchecked',
            size: 23,
            type: 'file',
          },
        ]
      ),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      exists: vi.fn(),
    } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'];
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [ROOT_B_COMPOSITE_KEY]: newContent,
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            fileRecordId: 'file-root-a',
            embeddingSetId: 'set-1',
            rootId: DB_ROOT_A_ID,
            relativePath: FILE_PATH,
            contentHash: oldHash,
            mtimeMs: 1000,
            size: 23,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
          {
            fileRecordId: 'file-root-b',
            embeddingSetId: 'set-1',
            rootId: DB_ROOT_B_ID,
            relativePath: FILE_PATH,
            contentHash: oldHash,
            mtimeMs: 1000,
            size: 23,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      fileSystemAdapter,
      resolveDbRootId: vi.fn(async (rootPath: string) =>
        rootPath === ROOT_B_PATH ? DB_ROOT_B_ID : DB_ROOT_A_ID
      ),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_B_PATH),
      scope: {
        mode: 'paths',
        changes: [{ kind: 'file', path: `${ROOT_B_PATH}/${FILE_PATH}`, type: 'modified' }],
      },
    });

    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
    expect(deps.fileContentProcessor?.processFiles).toHaveBeenCalled();
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        rootId: DB_ROOT_B_ID,
        changes: [
          expect.objectContaining({
            mode: 'replace',
            record: expect.objectContaining({
              id: 'file-root-b',
              path: FILE_PATH,
              content: newContent,
            }),
          }),
        ],
      })
    );
    const serializedBatch = JSON.stringify(vi.mocked(deps.applyManagedCacheBatch).mock.calls);
    expect(serializedBatch).not.toContain('file-root-a');
  });

  it('invalidates a watcher-removed file by exact root identity without import or chunking', async () => {
    const deps = createDeps();
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        mode: 'paths',
        changes: [{ kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'removed' }],
      },
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).toHaveBeenCalledWith({
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'exact',
          rootId: ROOT_PATH,
          relativePath: FILE_PATH,
        },
      ],
    });
    expect(deps.ensureChunkingWorker).not.toHaveBeenCalled();
    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
  });

  it('ignores root-level watcher removals without invalidation or import', async () => {
    const deps = createDeps();
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        mode: 'paths',
        changes: [{ kind: 'directory', path: ROOT_PATH, type: 'removed' }],
      },
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).not.toHaveBeenCalled();
    expect(deps.ensureChunkingWorker).not.toHaveBeenCalled();
    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
  });

  it('does not invalidate a file path that is recreated in the same watcher batch', async () => {
    const oldContent = 'export const value = 1;';
    const newContent = 'export const value = 2;';
    const oldHash = await generateContentHash(oldContent);
    const fileSystemAdapter = {
      readDirectory: vi.fn(async (handle): Promise<IFileNode[]> => {
        if (handle.path === ROOT_PATH) {
          return [
            {
              depth: 1,
              handle: createMockNodeHandle({
                kind: 'directory',
                name: 'src',
                path: `${ROOT_PATH}/src`,
              }),
              name: 'src',
              path: `${ROOT_PATH}/src`,
              rootFolderId: ROOT_PATH,
              selectionState: 'unchecked',
              type: 'directory',
            },
          ];
        }
        if (handle.path === `${ROOT_PATH}/src`) {
          return [
            {
              depth: 2,
              handle: createMockNodeHandle({
                kind: 'file',
                name: 'index.ts',
                path: `${ROOT_PATH}/${FILE_PATH}`,
              }),
              lastModified: 1000,
              name: 'index.ts',
              path: `${ROOT_PATH}/${FILE_PATH}`,
              rootFolderId: ROOT_PATH,
              selectionState: 'unchecked',
              size: 23,
              type: 'file',
            },
          ];
        }
        return [];
      }),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      exists: vi.fn(),
    } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'];
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: newContent,
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: oldHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            mtimeMs: 1000,
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            size: 23,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      fileSystemAdapter,
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        mode: 'paths',
        changes: [
          { kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'removed' },
          { kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'added' },
        ],
      },
    });

    expect(vi.mocked(deps.setStatus).mock.calls).not.toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            state: 'error',
          }),
        ],
      ])
    );
    expect(deps.fileContentProcessor?.processFiles).toHaveBeenCalled();
    expect(deps.invalidateManagedCacheEntriesByIdentity).not.toHaveBeenCalled();
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          expect.objectContaining({
            mode: 'replace',
            record: expect.objectContaining({
              id: 'file-1',
              path: FILE_PATH,
              content: newContent,
            }),
          }),
        ],
      })
    );
  });

  it('invalidates a same-batch recreated file when the replacement is excluded', async () => {
    const oldContent = 'export const value = 1;';
    const oldHash = await generateContentHash(oldContent);
    const fileSystemAdapter = {
      readDirectory: vi.fn(async (handle): Promise<IFileNode[]> => {
        if (handle.path === ROOT_PATH) {
          return [
            {
              depth: 1,
              handle: createMockNodeHandle({
                kind: 'directory',
                name: 'src',
                path: `${ROOT_PATH}/src`,
              }),
              name: 'src',
              path: `${ROOT_PATH}/src`,
              rootFolderId: ROOT_PATH,
              selectionState: 'unchecked',
              type: 'directory',
            },
          ];
        }
        if (handle.path === `${ROOT_PATH}/src`) {
          return [
            {
              depth: 2,
              handle: createMockNodeHandle({
                kind: 'file',
                name: 'index.ts',
                path: `${ROOT_PATH}/${FILE_PATH}`,
              }),
              lastModified: 1000,
              name: 'index.ts',
              path: `${ROOT_PATH}/${FILE_PATH}`,
              rootFolderId: ROOT_PATH,
              selectionState: 'unchecked',
              size: 800 * 1024,
              type: 'file',
            },
          ];
        }
        return [];
      }),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      exists: vi.fn(),
    } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'];
    const deps = createDeps({
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: oldHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            mtimeMs: 1000,
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            size: 23,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      fileSystemAdapter,
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        mode: 'paths',
        changes: [
          { kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'removed' },
          { kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'added' },
        ],
      },
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).toHaveBeenCalledWith({
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'exact',
          relativePath: FILE_PATH,
          rootId: ROOT_PATH,
        },
      ],
    });
    expect(deps.fileContentProcessor?.processFiles).not.toHaveBeenCalled();
    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
  });

  it('applies stale child removal and recreated file replacement in one managed-cache batch', async () => {
    const keptFilePath = 'src/rebuilt/keep.ts';
    const staleFilePath = 'src/rebuilt/stale.ts';
    const keptCompositeKey = encodeFileSelection(ROOT_PATH, keptFilePath);
    const oldContent = 'export const value = 1;';
    const newContent = 'export const value = 2;';
    const oldHash = await generateContentHash(oldContent);
    const fileSystemAdapter = {
      readDirectory: vi.fn(async (handle): Promise<IFileNode[]> => {
        if (handle.path === ROOT_PATH) {
          return [
            {
              depth: 1,
              handle: createMockNodeHandle({
                kind: 'directory',
                name: 'src',
                path: `${ROOT_PATH}/src`,
              }),
              name: 'src',
              path: `${ROOT_PATH}/src`,
              rootFolderId: ROOT_PATH,
              selectionState: 'unchecked',
              type: 'directory',
            },
          ];
        }
        if (handle.path === `${ROOT_PATH}/src`) {
          return [
            {
              depth: 2,
              handle: createMockNodeHandle({
                kind: 'directory',
                name: 'rebuilt',
                path: `${ROOT_PATH}/src/rebuilt`,
              }),
              name: 'rebuilt',
              path: `${ROOT_PATH}/src/rebuilt`,
              rootFolderId: ROOT_PATH,
              selectionState: 'unchecked',
              type: 'directory',
            },
          ];
        }
        if (handle.path === `${ROOT_PATH}/src/rebuilt`) {
          return [
            {
              depth: 3,
              handle: createMockNodeHandle({
                kind: 'file',
                name: 'keep.ts',
                path: `${ROOT_PATH}/${keptFilePath}`,
              }),
              lastModified: 1000,
              name: 'keep.ts',
              path: `${ROOT_PATH}/${keptFilePath}`,
              rootFolderId: ROOT_PATH,
              selectionState: 'unchecked',
              size: 24,
              type: 'file',
            },
          ];
        }
        return [];
      }),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      exists: vi.fn(),
    } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'];
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [keptCompositeKey]: newContent,
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: oldHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'kept-file',
            mtimeMs: 1000,
            relativePath: keptFilePath,
            rootId: ROOT_PATH,
            size: 23,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
          {
            contentHash: oldHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'stale-file',
            mtimeMs: 1000,
            relativePath: staleFilePath,
            rootId: ROOT_PATH,
            size: 23,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      fileSystemAdapter,
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        mode: 'paths',
        changes: [
          { kind: 'directory', path: `${ROOT_PATH}/src/rebuilt`, type: 'removed' },
          { kind: 'directory', path: `${ROOT_PATH}/src/rebuilt`, type: 'added' },
        ],
      },
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).not.toHaveBeenCalled();
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            mode: 'remove',
            target: {
              expectedFileRecordId: 'stale-file',
              mode: 'exact',
              relativePath: staleFilePath,
              rootId: ROOT_PATH,
            },
          }),
          expect.objectContaining({
            mode: 'replace',
            record: expect.objectContaining({
              id: 'kept-file',
              path: keptFilePath,
              content: newContent,
            }),
          }),
        ]),
      })
    );
  });

  it('invalidates a watcher-removed directory by prefix root identity', async () => {
    const deps = createDeps();
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        mode: 'paths',
        changes: [{ kind: 'directory', path: `${ROOT_PATH}/src/generated`, type: 'removed' }],
      },
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).toHaveBeenCalledWith({
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'prefix',
          rootId: ROOT_PATH,
          relativePathPrefix: 'src/generated',
        },
      ],
    });
    expect(deps.ensureChunkingWorker).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
  });

  it('hard-deletes full-scan entries missing from only the active db root', async () => {
    const indexedFilePath = 'src/index.ts';
    const missingFilePath = 'src/deleted.ts';
    readFullTreeWithOptionsMock.mockResolvedValueOnce([
      {
        depth: 1,
        handle: createMockNodeHandle({
          kind: 'file',
          name: 'index.ts',
          path: `${ROOT_B_PATH}/${indexedFilePath}`,
        }),
        lastModified: 1000,
        name: 'index.ts',
        path: `${ROOT_B_PATH}/${indexedFilePath}`,
        rootFolderId: ROOT_B_PATH,
        selectionState: 'unchecked',
        size: 23,
        type: 'file',
      },
    ]);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({})),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: 'indexed-hash',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-root-b-indexed',
            mtimeMs: 1000,
            relativePath: indexedFilePath,
            rootId: DB_ROOT_B_ID,
            size: 23,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
          {
            contentHash: 'stale-hash',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-root-b-deleted',
            mtimeMs: 1000,
            relativePath: missingFilePath,
            rootId: DB_ROOT_B_ID,
            size: 11,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
          {
            contentHash: 'other-root-hash',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-root-a-deleted',
            mtimeMs: 1000,
            relativePath: missingFilePath,
            rootId: DB_ROOT_A_ID,
            size: 11,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      resolveDbRootId: vi.fn(async () => DB_ROOT_B_ID),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_B_PATH),
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).toHaveBeenCalledWith({
      embeddingSetId: 'set-1',
      targets: [
        {
          expectedFileRecordId: 'file-root-b-deleted',
          mode: 'exact',
          rootId: DB_ROOT_B_ID,
          relativePath: missingFilePath,
        },
      ],
    });
    expect(
      JSON.stringify(vi.mocked(deps.invalidateManagedCacheEntriesByIdentity).mock.calls)
    ).not.toContain('file-root-a-deleted');
    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
  });

  it('requests strict full-scan traversal before planning missing-file deletes', async () => {
    const deps = createDeps();
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
        propagateDirectoryReadErrors: true,
      })
    );
  });

  it('scans only the changed watcher directory subtree', async () => {
    const subtreeFilePath = 'src/components/button.ts';
    const outsideFilePath = 'src/other.ts';
    const subtreeCompositeKey = encodeFileSelection(ROOT_PATH, subtreeFilePath);
    readFullTreeWithOptionsMock.mockResolvedValueOnce([
      {
        depth: 1,
        handle: createMockNodeHandle({
          kind: 'file',
          name: 'other.ts',
          path: `${ROOT_PATH}/${outsideFilePath}`,
        }),
        name: 'other.ts',
        path: `${ROOT_PATH}/${outsideFilePath}`,
        rootFolderId: ROOT_PATH,
        selectionState: 'unchecked',
        type: 'file',
      },
      {
        depth: 2,
        handle: createMockNodeHandle({
          kind: 'file',
          name: 'button.ts',
          path: `${ROOT_PATH}/${subtreeFilePath}`,
        }),
        name: 'button.ts',
        path: `${ROOT_PATH}/${subtreeFilePath}`,
        rootFolderId: ROOT_PATH,
        selectionState: 'unchecked',
        type: 'file',
      },
    ]);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [subtreeCompositeKey]: 'export const Button = 1;',
        })),
      },
      fileSystemAdapter: {
        readDirectory: vi.fn(async (handle): Promise<IFileNode[]> => {
          if (handle.path === ROOT_PATH) {
            return [
              {
                depth: 1,
                handle: createMockNodeHandle({
                  kind: 'directory',
                  name: 'src',
                  path: `${ROOT_PATH}/src`,
                }),
                name: 'src',
                path: `${ROOT_PATH}/src`,
                rootFolderId: ROOT_PATH,
                selectionState: 'unchecked',
                type: 'directory',
              },
            ];
          }
          if (handle.path === `${ROOT_PATH}/src`) {
            return [
              {
                depth: 2,
                handle: createMockNodeHandle({
                  kind: 'directory',
                  name: 'components',
                  path: `${ROOT_PATH}/src/components`,
                }),
                name: 'components',
                path: `${ROOT_PATH}/src/components`,
                rootFolderId: ROOT_PATH,
                selectionState: 'unchecked',
                type: 'directory',
              },
            ];
          }
          if (handle.path === `${ROOT_PATH}/src/components`) {
            return [
              {
                depth: 3,
                handle: createMockNodeHandle({
                  kind: 'file',
                  name: 'button.ts',
                  path: `${ROOT_PATH}/${subtreeFilePath}`,
                }),
                name: 'button.ts',
                path: `${ROOT_PATH}/${subtreeFilePath}`,
                rootFolderId: ROOT_PATH,
                selectionState: 'unchecked',
                type: 'file',
              },
            ];
          }
          return [];
        }),
        readFile: vi.fn(),
        requestDirectoryAccess: vi.fn(),
        exists: vi.fn(),
      } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'],
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        mode: 'paths',
        changes: [{ kind: 'directory', path: `${ROOT_PATH}/src/components`, type: 'modified' }],
      },
    });

    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
    const processFiles = deps.fileContentProcessor?.processFiles;
    if (!processFiles) {
      throw new Error('Expected test fileContentProcessor.');
    }
    const firstReadRequests = vi.mocked(processFiles).mock.calls[0]?.[0];
    expect(firstReadRequests?.map((request) => request.fileNode.path)).toEqual([
      `${ROOT_PATH}/${subtreeFilePath}`,
    ]);
    expect(JSON.stringify(vi.mocked(deps.applyManagedCacheBatch).mock.calls)).not.toContain(
      outsideFilePath
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
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: unchangedHash,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: unchangedHash,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: 'old-hash',
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
            }),
          }),
        ],
      })
    );
    expect(deps.chunkRepository.deleteByFileRecordId).not.toHaveBeenCalled();
    expect(deps.fileRecordRepository.update).not.toHaveBeenCalled();
  });

  it('imports with transactional chunk enqueue and then backfills through the runtime pipeline', async () => {
    const events: string[] = [];
    const deps = createDeps({
      ensureChunkingWorker: vi.fn(async () => {
        events.push('ensure-chunking-worker');
        return {
          chunkBatch: vi.fn(),
          chunkFile: vi.fn(),
          isReady: () => true,
          terminate: vi.fn(),
          transportKind: 'local-worker' as const,
        };
      }),
      ensureEmbeddingRuntimeStarted: vi.fn(async () => {
        events.push('ensure-embedding-runtime-started');
      }),
      enqueueBackfill: vi.fn(async () => {
        events.push('enqueue-backfill');
        return { requestId: 'background-indexing-backfill:test' };
      }),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
    });
    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      events.push('run-enhanced-import-start');
      await params.baseImportRunner({
        selectedFilePaths: params.request.selectedFilePaths,
        fileTree: params.request.fileTree,
        fileContents: params.request.fileContents,
        onProgress: () => {},
      });
      events.push('run-enhanced-import-complete');
      return [];
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
          enabled: true,
          model: 'openai::text-embedding-3-small',
          resolveTargetEmbeddingSetId: expect.any(Function),
        }),
        ports: expect.objectContaining({
          embeddingQueue: expect.objectContaining({
            enqueueBatch: expect.any(Function),
          }),
          sql: expect.objectContaining({
            runInTransaction: expect.any(Function),
          }),
        }),
      })
    );
    expect(deps.enqueueBackfill).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        source: 'background-indexing',
      })
    );
    expect(events).toEqual([
      'ensure-embedding-runtime-started',
      'ensure-chunking-worker',
      'run-enhanced-import-start',
      'run-enhanced-import-complete',
      'enqueue-backfill',
    ]);
  });

  it('waits for import QoS before entering importing status', async () => {
    const importYieldPolicy = createTestQosPolicy({
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      interBatchDelayMs: 1,
      progressThrottleMs: 500,
      reason: 'foreground-db-pressure',
      scanBatchSize: 0,
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    });
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      resolveQosPolicy: vi
        .fn()
        .mockResolvedValueOnce(BALANCED_QOS_POLICY)
        .mockResolvedValueOnce(importYieldPolicy)
        .mockResolvedValue(BALANCED_QOS_POLICY),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    const statusPatches = vi.mocked(deps.setStatus).mock.calls.map(([patch]) => patch);
    const waitingIndex = statusPatches.findIndex((patch) => patch.state === 'waiting');
    const importingIndex = statusPatches.findIndex((patch) => patch.state === 'importing');

    expect(deps.waitForBackgroundPermit).toHaveBeenCalledWith({
      label: 'Workspace Index import',
    });
    expect(waitingIndex).toBeGreaterThanOrEqual(0);
    expect(importingIndex).toBeGreaterThan(waitingIndex);
  });

  it('treats defensive backfill QoS denial as an abort instead of a sync failure', async () => {
    const backfillDeniedPolicy: WorkspaceIndexingQosPolicy = {
      ...BALANCED_QOS_POLICY,
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      reason: 'provider-rate-limited',
      scanBatchSize: 0,
      state: 'system-constrained',
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
        .mockResolvedValueOnce(BALANCED_QOS_POLICY)
        .mockResolvedValueOnce(BALANCED_QOS_POLICY)
        .mockResolvedValueOnce(backfillDeniedPolicy),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.enqueueBackfill).not.toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'error',
      })
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: 'Workspace Index QoS policy does not permit backfill enqueue work.',
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

  it('preserves detailed scan, chunking, embedding, and queue telemetry while embedding remains active', async () => {
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
        state: 'embedding',
        backfillRequestId: 'background-indexing-backfill:test',
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

  it('leaves embedding work in flight after enqueueing instead of waiting to transition to idle', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      getBackfillsInFlight: vi.fn().mockResolvedValueOnce([]),
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

    expect(deps.getBackfillsInFlight).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'embedding',
        backfillRequestId: 'background-indexing-backfill:test',
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'embedding',
        backfillRequestId: 'background-indexing-backfill:test',
      })
    );
  });

  it('surfaces detached background backfill terminal errors in Workspace Index status', async () => {
    type BackfillProgressListener = Parameters<
      WorkspaceCollectionSyncServiceDependencies['subscribeToBackfillProgress']
    >[0];
    let progressListener: BackfillProgressListener | undefined;
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
      subscribeToBackfillProgress: vi.fn((callback) => {
        progressListener = callback;
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

    if (!progressListener) {
      throw new Error('Expected backfill progress listener to be registered');
    }
    progressListener({
      embeddingSetId: 'set-1',
      requestId: 'background-indexing-backfill:test',
      source: 'background-indexing',
      stage: 'error',
      current: 0,
      total: 0,
      message: 'metadata missing',
    });

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        managedCollectionId: 'set-1',
        activeRootPath: ROOT_PATH,
        lastError: 'metadata missing',
      })
    );
  });

  it('keeps listening after backfill progress reaches total so later terminal failures surface', async () => {
    type BackfillProgressListener = Parameters<
      WorkspaceCollectionSyncServiceDependencies['subscribeToBackfillProgress']
    >[0];
    let progressListener: BackfillProgressListener | undefined;
    let subscribed = false;
    const unsubscribe = vi.fn(() => {
      subscribed = false;
    });
    const emitProgress = (progress: Parameters<BackfillProgressListener>[0]): void => {
      if (subscribed) {
        progressListener?.(progress);
      }
    };
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
      subscribeToBackfillProgress: vi.fn((callback) => {
        progressListener = callback;
        subscribed = true;
        return unsubscribe;
      }),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    if (!progressListener) {
      throw new Error('Expected backfill progress listener to be registered');
    }
    emitProgress({
      embeddingSetId: 'set-1',
      requestId: 'background-indexing-backfill:test',
      source: 'background-indexing',
      stage: 'backfill',
      current: 1,
      total: 1,
      message: 'queued all embedding jobs',
    });
    expect(unsubscribe).not.toHaveBeenCalled();

    emitProgress({
      embeddingSetId: 'set-1',
      requestId: 'background-indexing-backfill:test',
      source: 'background-indexing',
      stage: 'error',
      current: 1,
      total: 1,
      message: 'Backfill failed for embedding set',
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        managedCollectionId: 'set-1',
        activeRootPath: ROOT_PATH,
        lastError: 'Backfill failed for embedding set',
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

  it('treats a desktop { canceled: true } enqueue result as a benign cancellation, not a failure', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      // Desktop main resolves { canceled: true } for a deliberate cancellation
      // instead of rejecting. The service must re-raise it as an abort and handle
      // it benignly (isAbortError → no handleSyncFailure), never surfacing an
      // error status for what is a cancellation, not a failure.
      enqueueBackfill: vi.fn(async () => ({ canceled: true }) as const),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await expect(
      service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      })
    ).resolves.toBeUndefined();

    expect(deps.enqueueBackfill).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
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

  it('continues scan and import work when the managed collection already has an in-flight backfill', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      getBackfillsInFlight: vi.fn(async () => [
        {
          embeddingSetId: 'set-1',
          requestId: 'background-indexing-backfill:test',
          progress: { current: 2, total: 4 },
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

    expect(readFullTreeWithOptionsMock).toHaveBeenCalledTimes(1);
    expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledTimes(1);
    expect(deps.enqueueBackfill).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'recovering',
      })
    );
  });

  it('does not wait for in-flight backfill drain before discovering missing files', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
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

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(readFullTreeWithOptionsMock).toHaveBeenCalledTimes(1);
    expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        lastError:
          'Timed out waiting for background indexing backfill to drain for collection set-1.',
      })
    );
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
        state: 'embedding',
        backfillRequestId: 'background-indexing-backfill:test',
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

  it('cancels the previously tracked backfill when hosted provider access later rejects', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const deps = createDeps({
      enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
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
            rootId: ROOT_PATH,
            relativePath: FILE_PATH,
            contentHash: unchangedHash,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
      validateHostedProviderAccess: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Hosted provider API key is missing')),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });
    expect(deps.enqueueBackfill).toHaveBeenCalledTimes(1);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.cancelBackfill).toHaveBeenCalledWith('set-1');
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        lastError: 'Hosted provider API key is missing',
      })
    );
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

  it('does not overwrite a terminal backfill progress event with stale pending status', async () => {
    type BackfillProgressListener = Parameters<
      WorkspaceCollectionSyncServiceDependencies['subscribeToBackfillProgress']
    >[0];
    let progressListener: BackfillProgressListener | undefined;
    let subscribed = false;
    const unsubscribe = vi.fn(() => {
      subscribed = false;
    });
    const requestId = 'background-indexing-backfill:complete-before-return';
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 2;',
        })),
      },
      enqueueBackfill: vi.fn(async () => {
        if (!(subscribed && progressListener)) {
          throw new Error('Expected backfill progress listener to be registered before enqueue.');
        }
        progressListener({
          embeddingSetId: 'set-1',
          requestId,
          source: 'background-indexing',
          stage: 'complete',
          current: 7,
          total: 7,
          message: 'queued all embedding jobs',
        });
        return { requestId };
      }),
      subscribeToBackfillProgress: vi.fn((callback) => {
        progressListener = callback;
        subscribed = true;
        return unsubscribe;
      }),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'embedding',
        backfillRequestId: requestId,
        embeddingProgress: expect.objectContaining({
          chunksProcessed: 7,
          totalChunks: 7,
        }),
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

  it('passes resolved db root id to runRootFolderCacheImport when resolveDbRootId returns a value', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 1;',
        })),
      },
      resolveDbRootId: vi.fn().mockResolvedValue('root-db-1'),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({ rootId: 'root-db-1' })
    );
  });

  it('skips the import AND the scan (never writes a null-root_id row) when resolveDbRootId returns null', async () => {
    // Managed-cache identity is root_id (source_root_path retired). A root with
    // no resolvable db id can't persist a stable identity, so the pass
    // short-circuits BEFORE the scan — no tree walk, no content hashing — rather
    // than scanning everything only to skip the write of un-dedupable orphans.
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: 'export const value = 1;',
        })),
      },
      resolveDbRootId: vi.fn().mockResolvedValue(null),
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    // Reading the managed-cache metadata is the first DB touch inside the scan;
    // if the short-circuit fired before the scan it was never called.
    expect(deps.fileRecordRepository.listManagedCacheEntryMetadata).not.toHaveBeenCalled();
    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
  });
});
