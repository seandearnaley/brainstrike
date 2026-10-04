import type { ManagedCacheEntryMetadata } from '@brainstrike/db';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/indexing-contract/workspace-indexing-qos';
import type { ScopedLogger } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { generateContentHash } from '@brainstrike/utils';
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

const { backfillEmbeddingSetAssignmentsMock, readFullTreeWithOptionsMock, runEnhancedImportMock } =
  vi.hoisted(() => ({
    backfillEmbeddingSetAssignmentsMock: vi.fn(async () => undefined),
    readFullTreeWithOptionsMock: vi.fn(),
    runEnhancedImportMock: vi.fn(),
  }));

vi.mock('@brainstrike/file-system/directory-tree', () => ({
  readFullTreeWithOptions: readFullTreeWithOptionsMock,
}));

vi.mock('@brainstrike/file-import', () => ({
  backfillEmbeddingSetAssignments: backfillEmbeddingSetAssignmentsMock,
  runEnhancedImport: runEnhancedImportMock,
}));
const COMPOSITE_KEY = encodeFileSelection(ROOT_PATH, FILE_PATH);
const ROOT_B_PATH = '/workspace/root-b';
const DB_ROOT_A_ID = 'db-root-a';
const DB_ROOT_B_ID = 'db-root-b';
const ROOT_B_COMPOSITE_KEY = encodeFileSelection(ROOT_B_PATH, FILE_PATH);

/**
 * A `source: 'background-indexing'` run the host still reports as in flight
 * while no service instance tracks it — the state a provider remount leaves
 * behind after BST-1654's `detach()`.
 */
const DETACHED_BACKFILL: {
  embeddingSetId: string;
  progress: { current: number; total: number } | null;
  requestId: string;
} = {
  embeddingSetId: 'set-1',
  progress: { current: 12, total: 40 },
  requestId: 'background-indexing-backfill:detached',
};

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
    // Reset implementations and one-shot queues as well as call history for
    // this file's own configurable mocks only.
    // `clearAllMocks` left unused mockResolvedValueOnce values behind, so a
    // shuffled later test could see an empty tree and skip runtime startup.
    readFullTreeWithOptionsMock.mockReset();
    runEnhancedImportMock.mockReset();
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        rootFolderId: ROOT_PATH,
        type: 'file',
      },
    ]);
    runEnhancedImportMock.mockImplementation(async (params) => {
      const baseResults = await params.baseImportRunner({
        fileContents: params.request.fileContents,
        fileTree: params.request.fileTree,
        onProgress: () => {},
        selectedFilePaths: params.request.selectedFilePaths,
      });
      params.onChunkingStart?.(baseResults);
      return [];
    });
  });

  it('preserves dependency mock implementations across test resets', async () => {
    const result = backfillEmbeddingSetAssignmentsMock();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('does not start the local runtime when reconciliation finds no changes', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const fileContentProcessor = {
      processFiles: vi.fn(async () => ({
        [COMPOSITE_KEY]: { content: unchangedContent, status: 'accessible' as const },
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
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      fileSystemAdapter: {
        exists: vi.fn(),
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
        processedFiles: 1,
        state: 'idle',
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
        lastError: null,
        state: 'waiting',
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
          [COMPOSITE_KEY]: { content: 'export const value = 3;', status: 'accessible' as const },
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
    // Captured before useFakeTimers: the driver loop below must yield genuine
    // event-loop turns so real-async hops in the sync pipeline (e.g.
    // crypto.subtle.digest) can resolve between fake-timer advances.
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
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
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 7;', status: 'accessible' as const },
        })),
      },
      resolveQosPolicy: vi.fn(
        async (options?: { foregroundDbPressureStarvationBypass?: boolean }) =>
          options?.foregroundDbPressureStarvationBypass
            ? BALANCED_QOS_POLICY
            : foregroundYieldPolicy
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
      // Drive fake time until the sync settles. Progress alternates between
      // faked timers (the QoS loop re-resolves every interBatchDelayMs) and
      // real-async hops (crypto.subtle.digest resolves on a genuine
      // event-loop turn), so each step advances pending fake timers AND
      // yields one real macrotask turn. A fixed advance budget races the
      // real-async work under CI load: once it is exhausted the sync parks
      // on a fake timer nobody advances and the test times out.
      let advancedFakeMs = 0;
      while (!settled) {
        if (vi.getTimerCount() > 0) {
          await vi.advanceTimersByTimeAsync(250);
          advancedFakeMs += 250;
          // Far beyond the 5s starvation bound per phase: a regression that
          // never grants the bypass fails loudly instead of hanging.
          expect(advancedFakeMs).toBeLessThan(600_000);
        }
        await new Promise<void>((resolve) => {
          realSetTimeout(resolve, 0);
        });
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
  });

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
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          chunksWithEmbeddingsForSet: 1,
          totalChunks: 10,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: unchangedContent, status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      getBackfillsInFlight: vi.fn().mockResolvedValueOnce([]),
      subscribeToBackfillProgress: vi.fn((callback) => {
        callback({
          current: 3,
          embeddingSetId: 'set-1',
          message: 'chunk 3/10',
          requestId: 'background-indexing-backfill:test',
          total: 10,
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
        embeddingProgress: expect.objectContaining({
          chunksProcessed: 3,
          totalChunks: 10,
        }),
        state: 'embedding',
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        backfillRequestId: 'background-indexing-backfill:test',
        scanSummary: expect.objectContaining({
          changedFiles: 0,
          unchangedFiles: 1,
        }),
        state: 'embedding',
      })
    );
  });

  it('persists stat refreshes so hash-unchanged pre-migration rows join the stat-cache', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
        lastModified: 1000,
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        rootFolderId: ROOT_PATH,
        size: 42,
        type: 'file',
      },
    ]);
    const updateStatMetadata = vi.fn(async () => undefined);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: unchangedContent, status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            // Pre-migration row: no stored stats yet.
            mtimeMs: null,
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
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
        handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
        lastModified: 1000,
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        rootFolderId: ROOT_PATH,
        size: 42,
        type: 'file',
      },
    ]);
    const deps = createDeps({
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          chunksWithEmbeddingsForSet: 1,
          totalChunks: 10,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
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
            // Deliberately NOT the file's real hash: proves the skip is purely
            // stat-based and the coverage path is independent of content reads.
            contentHash: 'hash-never-consulted',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            mtimeMs: 1000,
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            size: 42,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
        handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
        lastModified: 1000,
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        rootFolderId: ROOT_PATH,
        size: 42,
        type: 'file',
      },
    ]);
    const deps = createDeps({
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          chunksWithEmbeddingsForSet: 1,
          totalChunks: 10,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
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
            contentHash: 'hash-never-consulted',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            mtimeMs: 1000,
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            size: 42,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
        processedFiles: 1,
        queuedFiles: 0,
        state: 'idle',
      })
    );
  });

  it('reprocesses stat-matching files whose prior import never completed chunking', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
        lastModified: 1000,
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        rootFolderId: ROOT_PATH,
        size: 42,
        type: 'file',
      },
    ]);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: unchangedContent, status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            chunksCount: 0,
            chunksProcessedAt: null,
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            mtimeMs: 1000,
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
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
        changes: [
          expect.objectContaining({
            mode: 'replace',
            record: expect.objectContaining({
              content: unchangedContent,
              id: 'file-1',
              path: FILE_PATH,
            }),
          }),
        ],
        rootId: ROOT_PATH,
      })
    );
  });

  it('surfaces a terminal error after three incomplete chunking redispatches', async () => {
    type BackfillProgressListener = Parameters<
      WorkspaceCollectionSyncServiceDependencies['subscribeToBackfillProgress']
    >[0];
    let progressListener: BackfillProgressListener | undefined;
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
        lastModified: 1000,
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        rootFolderId: ROOT_PATH,
        size: 42,
        type: 'file',
      },
    ]);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: unchangedContent, status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            chunksCount: 0,
            chunksProcessedAt: null,
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            mtimeMs: 1000,
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            size: 42,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
      subscribeToBackfillProgress: vi.fn((callback) => {
        progressListener = callback;
        return () => {};
      }),
    });
    const service = new WorkspaceCollectionSyncService(deps);
    const request = {
      adapterRootId: 'root-a-id',
      backfillMode: 'defer' as const,
      enabled: true,
      indexingPolicyPreset: 'balanced' as const,
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    };

    await service.sync(request);
    await service.sync(request);
    await service.sync(request);
    vi.mocked(deps.chunkRepository.getCoverageForSet).mockResolvedValueOnce({
      chunksWithEmbeddingsForSet: 0,
      totalChunks: 1,
    });
    await service.sync({ ...request, backfillMode: 'enqueue' });

    expect(runEnhancedImportMock).toHaveBeenCalledTimes(3);
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledTimes(3);
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastError: expect.stringContaining(
          'stopped re-dispatching "src/index.ts" after 3 redispatch attempts'
        ),
        state: 'error',
      })
    );
    expect(deps.enqueueBackfill).toHaveBeenCalledOnce();
    expect(progressListener).toBeDefined();

    progressListener?.({
      current: 1,
      embeddingSetId: 'set-1',
      message: 'chunk 1/2',
      requestId: 'background-indexing-backfill:test',
      stage: 'running',
      total: 2,
    });
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastError: expect.stringContaining('stopped re-dispatching "src/index.ts"'),
        state: 'error',
      })
    );

    await service.sync({
      ...request,
      scope: { changes: [], mode: 'paths' },
    });
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: expect.stringContaining('stopped re-dispatching "src/index.ts"'),
        state: 'error',
      })
    );

    await service.sync({
      ...request,
      scope: {
        changes: [{ kind: 'directory', path: ROOT_PATH, type: 'removed' }],
        mode: 'paths',
      },
    });
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: expect.stringContaining('stopped re-dispatching "src/index.ts"'),
        state: 'error',
      })
    );

    const processFiles = deps.fileContentProcessor?.processFiles;
    if (!processFiles) {
      throw new Error('Expected file content processor.');
    }
    const inaccessibleFileNode = {
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
      selectionState: 'unchecked' as const,
      size: 42,
      type: 'file' as const,
    };
    vi.mocked(deps.fileSystemAdapter.readDirectory).mockResolvedValueOnce([inaccessibleFileNode]);
    vi.mocked(processFiles).mockResolvedValueOnce({
      [COMPOSITE_KEY]: {
        message: 'File was temporarily inaccessible during rename.',
        status: 'inaccessible',
      },
    });
    await service.sync({
      ...request,
      scope: {
        changes: [{ kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'modified' }],
        mode: 'paths',
      },
    });
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: expect.stringContaining('stopped re-dispatching "src/index.ts"'),
        state: 'error',
      })
    );

    readFullTreeWithOptionsMock.mockResolvedValueOnce([inaccessibleFileNode]);
    vi.mocked(processFiles).mockResolvedValueOnce({
      [COMPOSITE_KEY]: {
        message: 'File remained inaccessible during full reconciliation.',
        status: 'inaccessible',
      },
    });
    await service.sync(request);
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: expect.stringContaining('stopped re-dispatching "src/index.ts"'),
        state: 'error',
      })
    );

    readFullTreeWithOptionsMock.mockResolvedValueOnce([]);
    vi.mocked(deps.resolveDbRootId).mockResolvedValueOnce(DB_ROOT_B_ID);
    await service.sync({
      backfillMode: 'defer',
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_B_PATH),
    });

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: expect.stringContaining('stopped re-dispatching "src/index.ts"'),
        state: 'error',
      })
    );

    service.reconcileMountedRoots('set-1', [
      { adapterRootId: 'root-b-id', dbRootId: null, rootPath: ROOT_PATH },
    ]);
    readFullTreeWithOptionsMock.mockResolvedValueOnce([]);
    await service.sync({
      backfillMode: 'defer',
      dbRootId: DB_ROOT_B_ID,
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: { ...createRootHandle(ROOT_PATH), rootId: 'root-b-id' },
    });
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: null,
        state: 'idle',
      })
    );

    vi.mocked(deps.embeddingSetsRepository.getById).mockResolvedValueOnce(
      createCollection({ id: 'set-2', name: 'Replacement collection' })
    );
    readFullTreeWithOptionsMock.mockResolvedValueOnce([]);
    await service.sync({
      backfillMode: 'defer',
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-2',
      rootDirectoryHandle: createRootHandle(ROOT_B_PATH),
    });

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastError: null,
        managedCollectionId: 'set-2',
        state: 'idle',
      })
    );
  });

  it('does not consume redispatch attempts before importer handoff', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
        lastModified: 1000,
        name: 'index.ts',
        path: `${ROOT_PATH}/${FILE_PATH}`,
        rootFolderId: ROOT_PATH,
        size: 42,
        type: 'file',
      },
    ]);
    const ensureChunkingWorker = vi
      .fn()
      .mockRejectedValueOnce(new Error('worker start failed 1'))
      .mockRejectedValueOnce(new Error('worker start failed 2'))
      .mockRejectedValueOnce(new Error('worker start failed 3'))
      .mockResolvedValue({
        chunkBatch: vi.fn(),
        chunkFile: vi.fn(),
        isReady: () => true,
        terminate: vi.fn(),
        transportKind: 'local-worker' as const,
      });
    const deps = createDeps({
      ensureChunkingWorker,
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: unchangedContent, status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            chunksCount: 0,
            chunksProcessedAt: null,
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            mtimeMs: 1000,
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            size: 42,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);
    const request = {
      backfillMode: 'defer' as const,
      enabled: true,
      indexingPolicyPreset: 'balanced' as const,
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    };

    await service.sync(request);
    await service.sync(request);
    await service.sync(request);
    await service.sync(request);

    expect(ensureChunkingWorker).toHaveBeenCalledTimes(4);
    expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: expect.stringContaining('stopped re-dispatching'),
      })
    );
  });

  it.each([false, true])(
    'force-reads a watcher-modified file and replaces only the matching db root identity (mixed ignore edit: %s)',
    async (mixedIgnoreEdit) => {
      const oldContent = 'export const value = 1;';
      const newContent = 'export const value = 2;';
      const oldHash = await generateContentHash(oldContent);
      const fileSystemAdapter = {
        exists: vi.fn(),
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
      } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'];
      if (mixedIgnoreEdit) {
        readFullTreeWithOptionsMock.mockResolvedValue(await fileSystemAdapter.readDirectory());
      }
      const deps = createDeps({
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [ROOT_B_COMPOSITE_KEY]: { content: newContent, status: 'accessible' as const },
          })),
        },
        fileRecordRepository: {
          findById: vi.fn(async () => null),
          findByIds: vi.fn(async () => []),
          listManagedCacheEntryMetadata: vi.fn(async () => [
            {
              contentHash: oldHash,
              embeddingSetId: 'set-1',
              fileRecordId: 'file-root-a',
              mtimeMs: 1000,
              relativePath: FILE_PATH,
              rootId: DB_ROOT_A_ID,
              size: 23,
              updatedAt: new Date().toISOString(),
            } satisfies ManagedCacheEntryMetadata,
            {
              contentHash: oldHash,
              embeddingSetId: 'set-1',
              fileRecordId: 'file-root-b',
              mtimeMs: 1000,
              relativePath: FILE_PATH,
              rootId: DB_ROOT_B_ID,
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
          changes: [
            { kind: 'file', path: `${ROOT_B_PATH}/${FILE_PATH}`, type: 'modified' },
            ...(mixedIgnoreEdit
              ? [
                  {
                    kind: 'file' as const,
                    path: `${ROOT_B_PATH}/.gitignore`,
                    type: 'modified' as const,
                  },
                ]
              : []),
          ],
          mode: 'paths',
        },
      });

      expect(readFullTreeWithOptionsMock.mock.calls.length).toBe(mixedIgnoreEdit ? 1 : 0);
      expect(deps.fileContentProcessor?.processFiles).toHaveBeenCalled();
      expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: [
            expect.objectContaining({
              mode: 'replace',
              record: expect.objectContaining({
                content: newContent,
                id: 'file-root-b',
                path: FILE_PATH,
              }),
            }),
          ],
          rootId: DB_ROOT_B_ID,
        })
      );
      const serializedBatch = JSON.stringify(vi.mocked(deps.applyManagedCacheBatch).mock.calls);
      expect(serializedBatch).not.toContain('file-root-a');
    }
  );

  it('splits large invalidation target sets into bounded requests so one request cannot monopolize the serial DB host', async () => {
    // The desktop DB host executes one IPC request at a time; a single
    // invalidate request covering thousands of targets would block every
    // other DB request (search, status, live queries) for its full duration
    // no matter how the DB layer batches transactions internally.
    const deps = createDeps();
    const service = new WorkspaceCollectionSyncService(deps);
    const changes = Array.from({ length: 2500 }, (_, index) => ({
      kind: 'file' as const,
      path: `${ROOT_PATH}/src/gone/${index}.ts`,
      type: 'removed' as const,
    }));

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: { changes, mode: 'paths' },
    });

    const calls = vi.mocked(deps.invalidateManagedCacheEntriesByIdentity).mock.calls;
    expect(calls.length).toBe(3);
    for (const [callArgs] of calls) {
      expect(callArgs.targets.length).toBeLessThanOrEqual(1000);
      expect(callArgs.embeddingSetId).toBe('set-1');
    }
    const allPaths = calls.flatMap(([callArgs]) =>
      callArgs.targets.map((target) =>
        'relativePath' in target ? target.relativePath : target.relativePathPrefix
      )
    );
    expect(new Set(allPaths).size).toBe(2500);
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
        changes: [{ kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'removed' }],
        mode: 'paths',
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
        changes: [{ kind: 'directory', path: ROOT_PATH, type: 'removed' }],
        mode: 'paths',
      },
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).not.toHaveBeenCalled();
    expect(deps.ensureChunkingWorker).not.toHaveBeenCalled();
    expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
  });

  it.each([false, true])(
    'does not invalidate a file path that is recreated in the same watcher batch (truncated: %s)',
    async (truncatedRecreation) => {
      const oldContent = 'export const value = 1;';
      const newContent = 'export const value = 2;';
      const oldHash = await generateContentHash(oldContent);
      const fileSystemAdapter = {
        exists: vi.fn(),
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
              ...(truncatedRecreation
                ? [
                    {
                      depth: 2,
                      handle: createMockNodeHandle({
                        kind: 'file',
                        name: 'truncated',
                        path: `${ROOT_PATH}/src/truncated`,
                      }),
                      name: 'truncated',
                      path: `${ROOT_PATH}/src/truncated`,
                      rootFolderId: ROOT_PATH,
                      selectionState: 'unchecked' as const,
                      type: 'truncated' as const,
                    },
                  ]
                : []),
            ];
          }
          return [];
        }),
        readFile: vi.fn(),
        requestDirectoryAccess: vi.fn(),
      } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'];
      const deps = createDeps({
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: newContent, status: 'accessible' as const },
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
          changes: [
            { kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'removed' },
            { kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'added' },
          ],
          mode: 'paths',
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
      expect(deps.invalidateManagedCacheEntriesByIdentity).not.toHaveBeenCalled();
      if (truncatedRecreation) {
        expect(deps.fileContentProcessor?.processFiles).not.toHaveBeenCalled();
        expect(deps.applyManagedCacheBatch).not.toHaveBeenCalled();
        return;
      }
      expect(deps.fileContentProcessor?.processFiles).toHaveBeenCalled();
      expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: [
            expect.objectContaining({
              mode: 'replace',
              record: expect.objectContaining({
                content: newContent,
                id: 'file-1',
                path: FILE_PATH,
              }),
            }),
          ],
        })
      );
    }
  );

  it('invalidates a same-batch recreated file when the replacement is excluded', async () => {
    const oldContent = 'export const value = 1;';
    const oldHash = await generateContentHash(oldContent);
    const fileSystemAdapter = {
      exists: vi.fn(),
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
        changes: [
          { kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'removed' },
          { kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'added' },
        ],
        mode: 'paths',
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

  it('deletes stale children when a removed directory is recreated with fewer files', async () => {
    const keptFilePath = 'src/rebuilt/keep.ts';
    const staleFilePath = 'src/rebuilt/stale.ts';
    const keptCompositeKey = encodeFileSelection(ROOT_PATH, keptFilePath);
    const oldContent = 'export const value = 1;';
    const newContent = 'export const value = 2;';
    const oldHash = await generateContentHash(oldContent);
    const fileSystemAdapter = {
      exists: vi.fn(),
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
    } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'];
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [keptCompositeKey]: { content: newContent, status: 'accessible' as const },
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
        changes: [
          { kind: 'directory', path: `${ROOT_PATH}/src/rebuilt`, type: 'removed' },
          { kind: 'directory', path: `${ROOT_PATH}/src/rebuilt`, type: 'added' },
        ],
        mode: 'paths',
      },
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).toHaveBeenCalledWith({
      embeddingSetId: 'set-1',
      targets: [
        {
          expectedFileRecordId: 'stale-file',
          mode: 'exact',
          relativePath: staleFilePath,
          rootId: ROOT_PATH,
        },
      ],
    });
    expect(
      JSON.stringify(vi.mocked(deps.invalidateManagedCacheEntriesByIdentity).mock.calls)
    ).not.toContain('kept-file');
    expect(deps.applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          expect.objectContaining({
            mode: 'replace',
            record: expect.objectContaining({
              content: newContent,
              id: 'kept-file',
              path: keptFilePath,
            }),
          }),
        ],
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
        changes: [{ kind: 'directory', path: `${ROOT_PATH}/src/generated`, type: 'removed' }],
        mode: 'paths',
      },
    });

    expect(deps.invalidateManagedCacheEntriesByIdentity).toHaveBeenCalledWith({
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'prefix',
          relativePathPrefix: 'src/generated',
          rootId: ROOT_PATH,
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
          relativePath: missingFilePath,
          rootId: DB_ROOT_B_ID,
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
          [subtreeCompositeKey]: {
            content: 'export const Button = 1;',
            status: 'accessible' as const,
          },
        })),
      },
      fileSystemAdapter: {
        exists: vi.fn(),
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
      } satisfies WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'],
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        changes: [{ kind: 'directory', path: `${ROOT_PATH}/src/components`, type: 'modified' }],
        mode: 'paths',
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
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          chunksWithEmbeddingsForSet: 1,
          totalChunks: 10,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
      fileContentProcessor: {
        processFiles: vi.fn(async (requests: readonly { compositeKey: string }[]) =>
          Object.fromEntries(
            requests.map((request) => [
              request.compositeKey,
              { content: unchangedContent, status: 'accessible' as const },
            ])
          )
        ),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
        embeddingProgress: null,
        queueProgress: null,
        state: 'embedding',
      })
    );
  });

  it('returns without transitioning to idle when the unchanged-files backfill path is cancelled after enqueueing', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const deps = createDeps({
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          chunksWithEmbeddingsForSet: 1,
          totalChunks: 10,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: unchangedContent, status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
          handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
          name: 'index.ts',
          path: '/workspace/root/src/index.ts',
          rootFolderId: ROOT_PATH,
          type: 'file',
        },
      ];
    });
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
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

  it('counts content-gate exclusions alongside policy exclusions in the scan summary', async () => {
    // One directory excluded by the entry policy during the tree walk, plus one
    // file whose CONTENT the import gate refuses (null bytes behind a text
    // extension). Both must appear in excludedEntries — the full-scan path used
    // to overwrite the content-gate count with only the tree-walk count.
    readFullTreeWithOptionsMock.mockImplementationOnce(async (_adapter, _handle, options) => {
      options?.onEntrySkipped?.({
        entryType: 'directory',
        reason: 'entry-policy',
        relativePath: 'coverage',
      });
      return [
        {
          handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
          name: 'index.ts',
          path: '/workspace/root/src/index.ts',
          rootFolderId: ROOT_PATH,
          type: 'file',
        },
        {
          handle: { path: `${ROOT_PATH}/docs/binary-content.md`, platform: 'electron' },
          name: 'binary-content.md',
          path: `${ROOT_PATH}/docs/binary-content.md`,
          rootFolderId: ROOT_PATH,
          type: 'file',
        },
      ];
    });
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async (requests: Array<{ compositeKey: string }>) =>
          Object.fromEntries(
            requests.map((request) => [
              request.compositeKey,
              {
                content: request.compositeKey.includes('binary-content.md')
                  ? 'looks like markdown but contains a null\0byte'
                  : 'export const value = 1;',
                status: 'accessible' as const,
              },
            ])
          )
        ),
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
        scanSummary: expect.objectContaining({
          excludedEntries: 2,
        }),
      })
    );
  });

  it('surfaces truncated directory listings from a full scan in the scan summary', async () => {
    readFullTreeWithOptionsMock.mockImplementationOnce(async (_adapter, _handle, options) => {
      options?.onDirectoryTruncated?.({ depth: 0, path: ROOT_PATH });
      return [
        {
          handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
          name: 'index.ts',
          path: `${ROOT_PATH}/${FILE_PATH}`,
          rootFolderId: ROOT_PATH,
          type: 'file',
        },
      ];
    });
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
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
        onDirectoryTruncated: expect.any(Function),
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scanSummary: expect.objectContaining({
          truncatedDirectories: 1,
        }),
      })
    );
  });

  it('surfaces truncated directory listings from a scoped scan in the scan summary', async () => {
    const truncatedEntry = (parentPath: string): IFileNode =>
      ({
        handle: createMockNodeHandle({
          kind: 'file',
          name: '…truncated…',
          path: `${parentPath}/…truncated…`,
        }),
        name: 'Showing first 10,000 entries',
        path: `${parentPath}/…truncated…`,
        rootFolderId: ROOT_PATH,
        type: 'truncated',
      }) as IFileNode;
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
        })),
      },
      fileSystemAdapter: {
        exists: vi.fn(),
        readDirectory: vi.fn(async (handle: { path: string }): Promise<IFileNode[]> => {
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
              } as IFileNode,
              truncatedEntry(ROOT_PATH),
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
                name: 'index.ts',
                path: `${ROOT_PATH}/${FILE_PATH}`,
                rootFolderId: ROOT_PATH,
                selectionState: 'unchecked',
                size: 24,
                type: 'file',
              } as IFileNode,
              truncatedEntry(`${ROOT_PATH}/src`),
            ];
          }
          return [];
        }),
        readFile: vi.fn(),
        requestDirectoryAccess: vi.fn(),
      } as unknown as WorkspaceCollectionSyncServiceDependencies['fileSystemAdapter'],
    });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
      scope: {
        changes: [{ kind: 'file', path: `${ROOT_PATH}/${FILE_PATH}`, type: 'modified' }],
        mode: 'paths',
      },
    });

    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
    // Unknown root rules withhold descent, so only that admitted listing reports truncation.
    expect(deps.fileSystemAdapter.readDirectory).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: `${ROOT_PATH}/src` }),
      expect.anything()
    );
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        scanSummary: expect.objectContaining({
          truncatedDirectories: 1,
        }),
      })
    );
  });

  it('does not invalidate cached rows under a truncated directory during a full scan', async () => {
    // A truncated listing means "absent from the tree" is NOT evidence of
    // deletion: rows past the 10,000-entry cap must survive the missing-file
    // reconciliation, while rows outside the truncated subtree still invalidate.
    readFullTreeWithOptionsMock.mockImplementationOnce(async (_adapter, _handle, options) => {
      options?.onDirectoryTruncated?.({ depth: 1, path: `${ROOT_PATH}/src` });
      return [
        {
          handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
          name: 'index.ts',
          path: `${ROOT_PATH}/${FILE_PATH}`,
          rootFolderId: ROOT_PATH,
          type: 'file',
        },
      ];
    });
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: 'hash-beyond-cap',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-beyond-cap',
            mtimeMs: 1000,
            relativePath: 'src/beyond-cap.ts',
            rootId: ROOT_PATH,
            size: 42,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
          {
            contentHash: 'hash-gone',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-really-gone',
            mtimeMs: 1000,
            relativePath: 'docs/really-gone.ts',
            rootId: ROOT_PATH,
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

    const invalidatedPaths = vi
      .mocked(deps.invalidateManagedCacheEntriesByIdentity)
      .mock.calls.flatMap(([callArgs]) =>
        callArgs.targets.map((target) =>
          'relativePath' in target ? target.relativePath : target.relativePathPrefix
        )
      );
    expect(invalidatedPaths).toContain('docs/really-gone.ts');
    expect(invalidatedPaths).not.toContain('src/beyond-cap.ts');
  });

  it('propagates scan and content-processing progress through the status reporter', async () => {
    readFullTreeWithOptionsMock.mockImplementationOnce(async (_adapter, _handle, options) => {
      options?.updateProgress?.();
      return [
        {
          handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
          name: 'index.ts',
          path: '/workspace/root/src/index.ts',
          rootFolderId: ROOT_PATH,
          type: 'file',
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
            [firstRequest.compositeKey]: {
              content: 'export const value = 1;',
              status: 'accessible' as const,
            },
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
          [COMPOSITE_KEY]: {
            content:
              'export const marker = "Binary file - preview not available"; export const ok = true;',
            status: 'accessible' as const,
          },
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
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: {
              message: 'Binary file - preview not available',
              status: 'inaccessible' as const,
            },
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
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })
          .mockResolvedValueOnce({}),
      },
    });
    let importResults: Array<{ error?: string; id: string; imported: boolean }> = [];
    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      importResults = await params.baseImportRunner({
        fileContents: params.request.fileContents,
        fileTree: params.request.fileTree,
        onProgress: () => {},
        selectedFilePaths: params.request.selectedFilePaths,
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
        error: 'Background cache import descriptor is missing.',
        id: expect.any(String),
        imported: false,
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
            [COMPOSITE_KEY]: { content: initialContent, status: 'accessible' as const },
          })
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: { content: importTimeContent, status: 'accessible' as const },
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
        changes: [
          expect.objectContaining({
            mode: 'import',
            record: expect.objectContaining({
              content: importTimeContent,
              contentHash: await generateContentHash(importTimeContent),
            }),
          }),
        ],
        embeddingSetId: 'set-1',
      })
    );
  });

  it('uses one createdAt timestamp for all imports in the same managed-cache batch', async () => {
    const secondFilePath = 'src/utils.ts';
    const secondCompositeKey = encodeFileSelection(ROOT_PATH, secondFilePath);
    readFullTreeWithOptionsMock.mockResolvedValueOnce([
      {
        handle: { path: `${ROOT_PATH}/${FILE_PATH}`, platform: 'electron' },
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        rootFolderId: ROOT_PATH,
        type: 'file',
      },
      {
        handle: { path: `${ROOT_PATH}/${secondFilePath}`, platform: 'electron' },
        name: 'utils.ts',
        path: '/workspace/root/src/utils.ts',
        rootFolderId: ROOT_PATH,
        type: 'file',
      },
    ]);
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi
          .fn()
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: {
              content: 'export const indexValue = 1;',
              status: 'accessible' as const,
            },
            [secondCompositeKey]: {
              content: 'export const utilValue = 2;',
              status: 'accessible' as const,
            },
          })
          .mockResolvedValueOnce({
            [COMPOSITE_KEY]: {
              content: 'export const indexValue = 1;',
              status: 'accessible' as const,
            },
            [secondCompositeKey]: {
              content: 'export const utilValue = 2;',
              status: 'accessible' as const,
            },
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

  it('does not publish throttled progress after its sync run is superseded', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps({
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
          })),
        },
      });
      const service = new WorkspaceCollectionSyncService(deps);
      let releaseSupersededImport!: () => void;
      const supersededImportReleased = new Promise<void>((resolve) => {
        releaseSupersededImport = resolve;
      });
      let firstImportStarted!: () => void;
      const firstImportStartedPromise = new Promise<void>((resolve) => {
        firstImportStarted = resolve;
      });

      runEnhancedImportMock
        .mockImplementationOnce(async (params) => {
          params.progressHandlers.emit?.({
            completed: 0,
            current: 'venv/lib/python3.11/site-packages/torch/first.py',
            errors: [],
            phase: 'importing',
            total: 2,
          });
          params.progressHandlers.emit?.({
            completed: 1,
            current: 'venv/lib/python3.11/site-packages/torch/trailing.py',
            errors: [],
            phase: 'importing',
            total: 2,
          });
          firstImportStarted();
          await supersededImportReleased;
          return [];
        })
        .mockResolvedValueOnce([]);

      const supersededSync = service.sync({
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      await firstImportStartedPromise;

      await service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      const currentRunStatus = vi.mocked(deps.setStatus).mock.lastCall?.[0];
      const currentRunStatusCallCount = vi.mocked(deps.setStatus).mock.calls.length;
      expect(currentRunStatus).toEqual(expect.objectContaining({ state: 'embedding' }));

      await vi.advanceTimersByTimeAsync(100);
      releaseSupersededImport();
      await supersededSync;

      expect(deps.setStatus).toHaveBeenCalledTimes(currentRunStatusCallCount);
      expect(deps.setStatus).toHaveBeenLastCalledWith(currentRunStatus);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears stale chunk metadata before replacing an indexed file', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: 'old-hash',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
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
        changes: [
          expect.objectContaining({
            mode: 'replace',
            record: expect.objectContaining({
              id: 'file-1',
              path: FILE_PATH,
            }),
          }),
        ],
        embeddingSetId: 'set-1',
      })
    );
    expect(deps.chunkRepository.deleteByFileRecordId).not.toHaveBeenCalled();
    expect(deps.fileRecordRepository.update).not.toHaveBeenCalled();
  });

  it('imports with transactional chunk enqueue and then backfills through the runtime pipeline', async () => {
    const events: string[] = [];
    const deps = createDeps({
      enqueueBackfill: vi.fn(async () => {
        events.push('enqueue-backfill');
        return { requestId: 'background-indexing-backfill:test' };
      }),
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
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
    });
    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      events.push('run-enhanced-import-start');
      await params.baseImportRunner({
        fileContents: params.request.fileContents,
        fileTree: params.request.fileTree,
        onProgress: () => {},
        selectedFilePaths: params.request.selectedFilePaths,
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
      chunkBatch: vi.fn(),
      chunkFile: vi.fn(),
      isReady: () => true,
      terminate: vi.fn(),
      transportKind: 'host-proxy' as const,
    };
    const deps = createDeps({
      ensureChunkingWorker: vi.fn(async () => chunkingWorkerPort),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
      enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
      subscribeToBackfillProgress: vi.fn((callback) => {
        queueMicrotask(() => {
          callback({
            current: 2,
            embeddingSetId: 'set-1',
            message: 'chunk 2/3',
            requestId: 'background-indexing-backfill:test',
            total: 3,
          });
          callback({
            current: 3,
            embeddingSetId: 'set-1',
            message: 'chunk 3/3',
            requestId: 'background-indexing-backfill:test',
            total: 3,
          });
        });
        return () => {};
      }),
    });
    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      params.progressHandlers.emit?.({
        chunkingProgress: {
          chunksCreated: 3,
          currentFile: 'src/index.ts',
          filesProcessed: 1,
          strategyUsed: 'sentence',
          totalFiles: 1,
        },
        completed: 1,
        current: 'src/index.ts',
        errors: [],
        phase: 'chunking',
        total: 1,
      });
      params.progressHandlers.emit?.({
        chunkingProgress: {
          chunksCreated: 3,
          currentFile: 'src/index.ts',
          filesProcessed: 1,
          strategyUsed: 'sentence',
          totalFiles: 1,
        },
        completed: 1,
        current: 'src/index.ts',
        errors: [],
        phase: 'complete',
        total: 1,
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
        chunkingProgress: expect.objectContaining({
          chunksCreated: 3,
          filesProcessed: 1,
          totalFiles: 1,
        }),
        embeddingProgress: expect.objectContaining({
          chunksProcessed: 3,
          modelName: 'text-embedding-3-small',
          totalChunks: 3,
        }),
        queueProgress: expect.objectContaining({
          pending: 0,
          processed: 3,
          totalQueued: 3,
        }),
        state: 'embedding',
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        backfillRequestId: 'background-indexing-backfill:test',
        processedFiles: 1,
        queuedFiles: 0,
        scanSummary: {
          changedFiles: 1,
          discoveredFiles: 1,
          excludedEntries: 0,
          truncatedDirectories: 0,
          unchangedFiles: 0,
        },
        state: 'embedding',
      })
    );
  });

  it('leaves embedding work in flight after enqueueing instead of waiting to transition to idle', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
      getBackfillsInFlight: vi.fn().mockResolvedValueOnce([]),
      subscribeToBackfillProgress: vi.fn((callback) => {
        callback({
          current: 1,
          embeddingSetId: 'set-1',
          message: 'chunk 1/3',
          requestId: 'background-indexing-backfill:test',
          total: 3,
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
        backfillRequestId: 'background-indexing-backfill:test',
        state: 'embedding',
      })
    );
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        backfillRequestId: 'background-indexing-backfill:test',
        state: 'embedding',
      })
    );
  });

  it('surfaces detached background backfill terminal errors in Workspace Index status', async () => {
    type BackfillProgressListener = Parameters<
      WorkspaceCollectionSyncServiceDependencies['subscribeToBackfillProgress']
    >[0];
    let progressListener: BackfillProgressListener | undefined;
    const deps = createDeps({
      enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
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
      current: 0,
      embeddingSetId: 'set-1',
      message: 'metadata missing',
      requestId: 'background-indexing-backfill:test',
      source: 'background-indexing',
      stage: 'error',
      total: 0,
    });

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: 'metadata missing',
        managedCollectionId: 'set-1',
        state: 'error',
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
      enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
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
      current: 1,
      embeddingSetId: 'set-1',
      message: 'queued all embedding jobs',
      requestId: 'background-indexing-backfill:test',
      source: 'background-indexing',
      stage: 'backfill',
      total: 1,
    });
    expect(unsubscribe).not.toHaveBeenCalled();

    emitProgress({
      current: 1,
      embeddingSetId: 'set-1',
      message: 'Backfill failed for embedding set',
      requestId: 'background-indexing-backfill:test',
      source: 'background-indexing',
      stage: 'error',
      total: 1,
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: 'Backfill failed for embedding set',
        managedCollectionId: 'set-1',
        state: 'error',
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
      enqueueBackfill: vi.fn(async (_embeddingSetId, options): Promise<{ requestId: string }> => {
        expect(options.source).toBe('background-indexing');
        resolveBackfillStarted?.();
        await new Promise<never>((_, reject) => {
          rejectBackfill = reject;
        });
        return { requestId: 'background-indexing-backfill:test' };
      }),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
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
      // Desktop main resolves { canceled: true } for a deliberate cancellation
      // instead of rejecting. The service must re-raise it as an abort and handle
      // it benignly (isAbortError → no handleSyncFailure), never surfacing an
      // error status for what is a cancellation, not a failure.
      enqueueBackfill: vi.fn(async () => ({ canceled: true }) as const),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
    });
    const service = new WorkspaceCollectionSyncService(deps);

    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      const selectedFilePaths = {
        has: (key: string) => {
          if (key === COMPOSITE_KEY) {
            void service.cancel();
          }
          return true;
        },
        size: 1,
      } as unknown as Set<string>;

      await params.baseImportRunner({
        fileContents: params.request.fileContents,
        fileTree: params.request.fileTree,
        onProgress: () => {},
        selectedFilePaths,
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
      getBackfillsInFlight: vi.fn(async () => [
        {
          embeddingSetId: 'set-1',
          progress: { current: 2, total: 4 },
          requestId: 'background-indexing-backfill:test',
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
      getBackfillsInFlight: vi.fn(async () => [
        {
          embeddingSetId: 'set-1',
          progress: { current: 1, total: 4 },
          requestId: 'background-indexing-backfill:test',
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
        lastError:
          'Timed out waiting for background indexing backfill to drain for collection set-1.',
        state: 'error',
      })
    );
  });

  it('imports changed files in bounded batches instead of building a single full-run content map', async () => {
    const fileNodes = Array.from({ length: 30 }, (_, index) => ({
      handle: { path: `${ROOT_PATH}/src/file-${index}.ts`, platform: 'electron' },
      name: `file-${index}.ts`,
      path: `${ROOT_PATH}/src/file-${index}.ts`,
      rootFolderId: ROOT_PATH,
      type: 'file' as const,
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
              {
                content: `export const value${index} = ${index};`,
                status: 'accessible' as const,
              },
            ])
          );
        }),
      },
    });
    runEnhancedImportMock.mockImplementation(async (params) => {
      expect(Object.keys(params.request.fileContents).length).toBeLessThanOrEqual(24);
      await params.baseImportRunner({
        fileContents: params.request.fileContents,
        fileTree: params.request.fileTree,
        onProgress: () => {},
        selectedFilePaths: params.request.selectedFilePaths,
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
    });
    runEnhancedImportMock.mockImplementationOnce(async (params) => {
      params.progressHandlers.emit?.({
        chunkingProgress: {
          chunksCreated: 2,
          currentFile: 'src/index.ts',
          filesProcessed: 1,
          strategyUsed: 'sentence',
          totalFiles: 1,
        },
        completed: 1,
        current: 'src/index.ts',
        errors: [],
        phase: 'chunking',
        total: 1,
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
        backfillRequestId: 'background-indexing-backfill:test',
        chunkingProgress: expect.objectContaining({
          chunksCreated: 2,
          filesProcessed: 1,
        }),
        scanSummary: expect.objectContaining({
          changedFiles: 1,
        }),
        state: 'embedding',
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
        lastError: 'Chunking worker failed to start',
        state: 'error',
      })
    );
  });

  it.each([
    { managedCollectionId: 'set-1', rootPath: null },
    { managedCollectionId: null, rootPath: ROOT_PATH },
    { managedCollectionId: null, rootPath: null },
  ])('marks incomplete setup unconfigured: %j', async ({ managedCollectionId, rootPath }) => {
    // BST-1335: a managed collection can exist (background indexing enabled,
    // default collection created) before the user has picked a workspace
    // root. That is incomplete setup, not a failure — it must not land as an
    // `error` status or reach the durable warn+ error-transition logger.
    const log: ScopedLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };
    const deps = createDeps({ log });
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId,
      rootDirectoryHandle: rootPath === null ? null : createRootHandle(rootPath),
    });

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: rootPath,
        lastError: null,
        managedCollectionId,
        state: 'unconfigured',
      })
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('unconfigured'),
      expect.objectContaining({ managedCollectionId })
    );
    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
  });

  it('surfaces a missing required database dependency as an error', async () => {
    const deps = createDeps();
    // Simulate an untyped caller violating the constructor's required DB contract.
    Reflect.deleteProperty(deps, 'db');
    const service = new WorkspaceCollectionSyncService(deps);

    await service.sync({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      rootDirectoryHandle: createRootHandle(ROOT_PATH),
    });

    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRootPath: ROOT_PATH,
        lastError: 'Database is not ready.',
        managedCollectionId: 'set-1',
        state: 'error',
      })
    );
    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
  });

  it('surfaces invalid managed-collection metadata before scanning proceeds', async () => {
    const deps = createDeps({
      embeddingSetsRepository: {
        getById: vi.fn(async () =>
          createCollection({
            dimensions: 0,
            modelId: '',
            modelKey: '',
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
        lastError: 'Managed collection metadata is invalid.',
        state: 'error',
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
        lastError: 'Managed collection was not found. Select a new collection in Settings.',
        managedCollectionId: 'set-stale',
        state: 'error',
      })
    );
    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
  });

  it('fails cleanly when hosted provider access validation rejects', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
        lastError: 'Hosted provider API key is missing',
        state: 'error',
      })
    );
    expect(deps.ensureEmbeddingRuntimeStarted).not.toHaveBeenCalled();
  });

  it('cancels the previously tracked backfill when hosted provider access later rejects', async () => {
    const unchangedContent = 'export const value = 1;';
    const unchangedHash = await generateContentHash(unchangedContent);
    const deps = createDeps({
      chunkRepository: {
        deleteByFileRecordId: vi.fn(async () => undefined),
        getCoverageForSet: vi.fn(async () => ({
          chunksWithEmbeddingsForSet: 1,
          totalChunks: 10,
        })),
        insertMany: vi.fn(async () => []),
        update: vi.fn(async () => null),
      },
      enqueueBackfill: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: unchangedContent, status: 'accessible' as const },
        })),
      },
      fileRecordRepository: {
        findById: vi.fn(async () => null),
        findByIds: vi.fn(async () => []),
        listManagedCacheEntryMetadata: vi.fn(async () => [
          {
            contentHash: unchangedHash,
            embeddingSetId: 'set-1',
            fileRecordId: 'file-1',
            relativePath: FILE_PATH,
            rootId: ROOT_PATH,
            updatedAt: new Date().toISOString(),
          } satisfies ManagedCacheEntryMetadata,
        ]),
        update: vi.fn(async () => undefined),
        updateStatMetadata: vi.fn(async () => undefined),
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
        lastError: 'Hosted provider API key is missing',
        state: 'error',
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
      getBackfillsInFlight: vi.fn(async () => [
        {
          embeddingSetId: 'set-2',
          progress: { current: 1, total: 2 },
          requestId: 'background-indexing-backfill:stale',
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
          progress: { current: 1, total: 2 },
          requestId: 'background-indexing-backfill:stale',
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
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
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
      enqueueBackfill: vi.fn(async () => {
        if (!(subscribed && progressListener)) {
          throw new Error('Expected backfill progress listener to be registered before enqueue.');
        }
        progressListener({
          current: 7,
          embeddingSetId: 'set-1',
          message: 'queued all embedding jobs',
          requestId,
          source: 'background-indexing',
          stage: 'complete',
          total: 7,
        });
        return { requestId };
      }),
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
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
        backfillRequestId: requestId,
        embeddingProgress: expect.objectContaining({
          chunksProcessed: 7,
          totalChunks: 7,
        }),
        state: 'embedding',
      })
    );
  });

  it('ignores unrelated backfill progress events while tracking the managed collection request', async () => {
    const deps = createDeps({
      fileContentProcessor: {
        processFiles: vi.fn(async () => ({
          [COMPOSITE_KEY]: { content: 'export const value = 2;', status: 'accessible' as const },
        })),
      },
      subscribeToBackfillProgress: vi.fn((callback) => {
        callback({
          current: 9,
          embeddingSetId: 'set-2',
          message: 'wrong collection',
          requestId: 'background-indexing-backfill:other',
          total: 9,
        });
        callback({
          current: 1,
          embeddingSetId: 'set-1',
          message: 'chunk 1/2',
          requestId: 'background-indexing-backfill:test',
          total: 2,
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
        embeddingProgress: expect.objectContaining({
          chunksProcessed: 1,
          totalChunks: 2,
        }),
        managedCollectionId: 'set-1',
        state: 'embedding',
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
          [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
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
          [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
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

  // BST-1654: teardown ownership. `cancel()` is a deliberate stop (pause,
  // disable, restart) and must kill the host run. `detach()` is a requester
  // going away — it must release this renderer's local work and progress
  // subscription while the durable `source: 'background-indexing'` run keeps
  // going.
  describe('detach()', () => {
    function createBackfillDeps(unsubscribeProgress: () => void) {
      return createDeps({
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })),
        },
        subscribeToBackfillProgress: vi.fn(() => unsubscribeProgress),
      });
    }

    async function syncOnce(service: WorkspaceCollectionSyncService): Promise<void> {
      await service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
    }

    it('releases the tracked backfill without cancelling the host run', async () => {
      const unsubscribeProgress = vi.fn();
      const deps = createBackfillDeps(unsubscribeProgress);
      const service = new WorkspaceCollectionSyncService(deps);

      await syncOnce(service);
      expect(deps.enqueueBackfill).toHaveBeenCalledWith(
        'set-1',
        expect.objectContaining({ source: 'background-indexing' })
      );

      await service.detach();

      expect(deps.cancelBackfill).not.toHaveBeenCalled();
      expect(unsubscribeProgress).toHaveBeenCalledTimes(1);
    });

    it('is idempotent, and a later cancel still stops the run it detached from', async () => {
      const deps = createBackfillDeps(vi.fn());
      deps.getBackfillsInFlight = vi.fn(async () => [DETACHED_BACKFILL]);
      const service = new WorkspaceCollectionSyncService(deps);

      await syncOnce(service);
      await service.detach();
      await service.detach();
      expect(deps.cancelBackfill).not.toHaveBeenCalled();

      await service.cancel();

      expect(deps.cancelBackfill).toHaveBeenCalledWith('set-1');
    });

    it('still cancels the host run for an explicit cancel()', async () => {
      const deps = createBackfillDeps(vi.fn());
      const service = new WorkspaceCollectionSyncService(deps);

      await syncOnce(service);
      await service.cancel();

      expect(deps.cancelBackfill).toHaveBeenCalledWith('set-1');
    });

    /**
     * BST-1654 follow-up: the detach fix has to hold on web too, and web has no
     * host process to outlive the renderer. `enqueueLocalBackfill` awaits
     * `service.backfill()` with the caller's signal merged into the run, so the
     * returned promise IS the run and aborting that signal kills it. While the
     * renderer loop and the backfill shared one AbortController, `detach()`
     * aborted the run outright — navigation still destroyed the backfill on the
     * web path, which is the original bug, unfixed.
     */
    function createWebShapedBackfillDeps(): {
      deps: WorkspaceCollectionSyncServiceDependencies;
      runState: { aborted: boolean; signal: AbortSignal | undefined };
    } {
      const runState: { aborted: boolean; signal: AbortSignal | undefined } = {
        aborted: false,
        signal: undefined,
      };
      const deps = createDeps({
        enqueueBackfill: vi.fn((_embeddingSetId: string, options?: { signal?: AbortSignal }) => {
          runState.signal = options?.signal;
          // Never settles on its own: models a run still in progress.
          return new Promise<{ requestId: string }>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              runState.aborted = true;
              reject(
                Object.assign(new Error('Embedding backfill was canceled.'), {
                  name: 'AbortError',
                })
              );
            });
          });
        }) as unknown as WorkspaceCollectionSyncServiceDependencies['enqueueBackfill'],
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })),
        },
        subscribeToBackfillProgress: vi.fn(() => () => {}),
      });
      return { deps, runState };
    }

    it('leaves an in-progress web backfill running when the requester detaches', async () => {
      const { deps, runState } = createWebShapedBackfillDeps();
      const service = new WorkspaceCollectionSyncService(deps);

      // Not awaited: on web the sync pass only settles when the run does.
      const syncing = syncOnce(service);
      await vi.waitFor(() => expect(runState.signal).toBeDefined());

      await service.detach();
      await Promise.resolve();

      expect(runState.aborted).toBe(false);
      expect(runState.signal?.aborted).toBe(false);
      expect(deps.cancelBackfill).not.toHaveBeenCalled();

      // Settle the pending run so the test leaves nothing dangling.
      await service.cancel();
      await syncing;
    });

    it('aborts an in-progress web backfill on an explicit cancel()', async () => {
      const { deps, runState } = createWebShapedBackfillDeps();
      const service = new WorkspaceCollectionSyncService(deps);

      const syncing = syncOnce(service);
      await vi.waitFor(() => expect(runState.signal).toBeDefined());

      await service.cancel();
      await syncing;

      expect(runState.aborted).toBe(true);
    });
  });

  // BST-1654 (review round 3): detachment means "this provider instance stops
  // tracking the run", never "nobody can stop the run any more". A deliberate
  // stop arriving after a detach lands on a service whose `activeBackfill` is
  // null — a fresh provider instance never tracked the durable run — so it must
  // enumerate the host's in-flight `background-indexing` runs and cancel them
  // regardless of local tracking. Otherwise pause and disable leave embedding
  // and database work burning after an explicit user stop.
  describe('cancellation authority over a detached run', () => {
    function createUntrackingDeps(
      inFlight: readonly (typeof DETACHED_BACKFILL)[]
    ): WorkspaceCollectionSyncServiceDependencies {
      return createDeps({
        getBackfillsInFlight: vi.fn(async () => [...inFlight]),
      });
    }

    it('cancels a detached host run on an explicit cancel() with nothing tracked', async () => {
      const deps = createUntrackingDeps([DETACHED_BACKFILL]);
      const service = new WorkspaceCollectionSyncService(deps);

      await service.cancel();

      expect(deps.cancelBackfill).toHaveBeenCalledWith('set-1');
    });

    it('cancels a detached host run when background indexing is disabled', async () => {
      const deps = createUntrackingDeps([DETACHED_BACKFILL]);
      const service = new WorkspaceCollectionSyncService(deps);

      await service.sync({
        enabled: false,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });

      expect(deps.cancelBackfill).toHaveBeenCalledWith('set-1');
    });

    it('leaves in-flight runs background indexing does not own alone', async () => {
      const deps = createUntrackingDeps([
        {
          embeddingSetId: 'set-2',
          progress: null,
          requestId: 'manual-backfill:1',
        },
      ]);
      const service = new WorkspaceCollectionSyncService(deps);

      await service.cancel();

      expect(deps.cancelBackfill).not.toHaveBeenCalled();
    });

    it('does not cancel a detached host run on detach()', async () => {
      const deps = createUntrackingDeps([DETACHED_BACKFILL]);
      const service = new WorkspaceCollectionSyncService(deps);

      await service.detach();

      expect(deps.cancelBackfill).not.toHaveBeenCalled();
    });

    /**
     * BST-1654 follow-up: the enumeration sweep must be failure-isolated. A
     * plain `for … await` loop lets the first rejection escape, so a single
     * uncooperative run stops every later cancel from even being attempted —
     * the user presses pause and indexing keeps running, the exact failure this
     * enumeration exists to prevent, reintroduced through a different door.
     */
    it('cancels every enumerated run even when one cancel rejects', async () => {
      const cancelBackfill = vi.fn(async (embeddingSetId: string) => {
        if (embeddingSetId === 'set-a') {
          throw new Error('host refused the cancel');
        }
      });
      const deps = createDeps({
        cancelBackfill,
        getBackfillsInFlight: vi.fn(async () => [
          { embeddingSetId: 'set-a', progress: null, requestId: 'background-indexing-backfill:a' },
          { embeddingSetId: 'set-b', progress: null, requestId: 'background-indexing-backfill:b' },
        ]),
      });
      const service = new WorkspaceCollectionSyncService(deps);

      const error = await service.cancel().then(
        () => null,
        (rejection: unknown) => rejection
      );

      expect(cancelBackfill.mock.calls.map((call) => call[0])).toEqual(['set-a', 'set-b']);
      // The undeliverable stop still surfaces — never silently degraded.
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toContain('set-a');
    });

    /**
     * BST-1654 follow-up: the stop-before-the-run-existed orphan. A `cancel()`
     * that lands while an enqueue is in flight sweeps a host that cannot report
     * the run yet, and the cancel it does fire (for the speculative `pending:`
     * tracking entry) races ahead of the run's creation — desktop main drops
     * the abort signal at the IPC boundary rather than honouring it, so the run
     * comes back alive behind the stop. What matters is not that *a* cancel
     * happened, but that one is ordered AFTER the run exists; otherwise a
     * deliberate pause leaves a brand-new background run burning untracked.
     */
    it('cancels a background run whose enqueue landed after the stop swept the host', async () => {
      const callLog: string[] = [];
      let releaseEnqueue: () => void = () => undefined;
      const enqueueLanded = new Promise<void>((resolve) => {
        releaseEnqueue = resolve;
      });
      const deps = createDeps({
        cancelBackfill: vi.fn(async (embeddingSetId: string) => {
          callLog.push(`cancel:${embeddingSetId}`);
        }),
        enqueueBackfill: vi.fn(async () => {
          await enqueueLanded;
          callLog.push('run-exists');
          return { requestId: 'background-indexing-backfill:raced' };
        }) as unknown as WorkspaceCollectionSyncServiceDependencies['enqueueBackfill'],
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })),
        },
        // The host has nothing to report: the run does not exist yet.
        getBackfillsInFlight: vi.fn(async () => []),
        subscribeToBackfillProgress: vi.fn(() => () => {}),
      });
      const service = new WorkspaceCollectionSyncService(deps);

      const syncing = service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      await vi.waitFor(() => expect(deps.enqueueBackfill).toHaveBeenCalled());

      // The stop sweeps an empty host, then the enqueue resolves behind it.
      await service.cancel();
      releaseEnqueue();
      await syncing;

      // A cancel must land after the run exists — not only before it.
      expect(callLog).toContain('run-exists');
      expect(callLog.slice(callLog.indexOf('run-exists'))).toContain('cancel:set-1');
    });

    /**
     * BST-1654 follow-up (review round 4): the orphan a set-scoped guard must NOT
     * abandon. A stop sweeps a host that cannot yet report pass A's run, then a sync
     * for a DIFFERENT set begins. A's enqueue resolves, creating a real run for its
     * own set — and that other pass's sweep already ran, before this run existed, so
     * nothing else will stop it. Reading "another pass holds the slot" as "not mine to
     * cancel" is how a paused indexer keeps burning.
     */
    it('still cancels its own orphan when the replacement is for another set', async () => {
      const callLog: string[] = [];
      let releaseEnqueue: () => void = () => undefined;
      const enqueueLanded = new Promise<void>((resolve) => {
        releaseEnqueue = resolve;
      });
      let enqueueCount = 0;
      const deps = createDeps({
        cancelBackfill: vi.fn(async (embeddingSetId: string) => {
          callLog.push(`cancel:${embeddingSetId}`);
        }),
        enqueueBackfill: vi.fn(async () => {
          enqueueCount += 1;
          if (enqueueCount === 1) {
            await enqueueLanded;
            callLog.push('orphan-run-exists');
            return { requestId: 'background-indexing-backfill:orphan' };
          }
          return { requestId: 'background-indexing-backfill:other-set' };
        }) as unknown as WorkspaceCollectionSyncServiceDependencies['enqueueBackfill'],
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })),
        },
        getBackfillsInFlight: vi.fn(async () => []),
        subscribeToBackfillProgress: vi.fn(() => () => {}),
      });
      const service = new WorkspaceCollectionSyncService(deps);

      const orphaned = service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      await vi.waitFor(() => expect(enqueueCount).toBe(1));

      // The stop sweeps a host with nothing to report, then a different set takes over.
      await service.cancel();
      await service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-2',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });

      releaseEnqueue();
      await orphaned;

      expect(callLog).toContain('orphan-run-exists');
      expect(callLog.slice(callLog.indexOf('orphan-run-exists'))).toContain('cancel:set-1');
    });

    /**
     * BST-1654 follow-up (review round 4): the mirror hazard the orphan cancel
     * created. `activeBackfill` is one slot and `cancelBackfill` takes only an
     * embedding-set id, so a continuation that resumes after a *replacement*
     * sync claimed the set cancels the replacement's run instead of its own —
     * a quick pause/resume or retrigger stops the indexing it just restarted.
     */
    it('does not cancel the replacement run when a superseded enqueue resolves late', async () => {
      const callLog: string[] = [];
      let releaseFirstEnqueue: () => void = () => undefined;
      const firstEnqueueLanded = new Promise<void>((resolve) => {
        releaseFirstEnqueue = resolve;
      });
      let enqueueCount = 0;
      const deps = createDeps({
        cancelBackfill: vi.fn(async (embeddingSetId: string) => {
          callLog.push(`cancel:${embeddingSetId}`);
        }),
        enqueueBackfill: vi.fn(async () => {
          enqueueCount += 1;
          if (enqueueCount === 1) {
            await firstEnqueueLanded;
            callLog.push('superseded-enqueue-resolved');
            return { requestId: 'background-indexing-backfill:superseded' };
          }
          callLog.push('replacement-exists');
          return { requestId: 'background-indexing-backfill:replacement' };
        }) as unknown as WorkspaceCollectionSyncServiceDependencies['enqueueBackfill'],
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })),
        },
        getBackfillsInFlight: vi.fn(async () => []),
        subscribeToBackfillProgress: vi.fn(() => () => {}),
      });
      const service = new WorkspaceCollectionSyncService(deps);

      const superseded = service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      await vi.waitFor(() => expect(enqueueCount).toBe(1));

      // The replacement claims the set while the first enqueue is still pending.
      await service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      await vi.waitFor(() => expect(callLog).toContain('replacement-exists'));

      releaseFirstEnqueue();
      await superseded;

      // Superseding the first pass legitimately cancels ITS run. What must never
      // happen is a cancel landing after the replacement's run exists: the id is
      // the only handle, so that cancel would stop the run just restarted.
      expect(callLog).toContain('superseded-enqueue-resolved');
      expect(callLog.slice(callLog.indexOf('replacement-exists'))).not.toContain('cancel:set-1');
      expect(deps.setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ backfillRequestId: 'background-indexing-backfill:replacement' })
      );
    });

    /**
     * BST-1654 follow-up (review round 4): the same ownership hazard on the
     * benign-cancel path. Desktop main resolves `{ canceled: true }` rather than
     * rejecting, so a superseded pass reaches its cleanup normally — and
     * `activeBackfill` is one slot, so clearing it unconditionally unsubscribes
     * whichever run replaced it and the UI stops seeing that run's progress.
     */
    it('leaves the replacement subscription alone when a superseded enqueue reports canceled', async () => {
      const unsubscribes: ReturnType<typeof vi.fn>[] = [];
      let releaseFirstEnqueue: () => void = () => undefined;
      const firstEnqueueLanded = new Promise<void>((resolve) => {
        releaseFirstEnqueue = resolve;
      });
      let enqueueCount = 0;
      const deps = createDeps({
        enqueueBackfill: vi.fn(async () => {
          enqueueCount += 1;
          if (enqueueCount === 1) {
            await firstEnqueueLanded;
            return { canceled: true };
          }
          return { requestId: 'background-indexing-backfill:replacement' };
        }) as unknown as WorkspaceCollectionSyncServiceDependencies['enqueueBackfill'],
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })),
        },
        getBackfillsInFlight: vi.fn(async () => []),
        subscribeToBackfillProgress: vi.fn(() => {
          const unsubscribe = vi.fn();
          unsubscribes.push(unsubscribe);
          return unsubscribe;
        }),
      });
      const service = new WorkspaceCollectionSyncService(deps);

      const superseded = service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      await vi.waitFor(() => expect(enqueueCount).toBe(1));

      await service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      await vi.waitFor(() => expect(unsubscribes.length).toBe(2));

      releaseFirstEnqueue();
      await superseded;

      expect(unsubscribes[1]).not.toHaveBeenCalled();

      // The slot must still HOLD the replacement, not merely have left its
      // subscription alive: a stale pass that nulls the tracking silently strands the
      // replacement's subscription, and the next teardown has nothing left to release.
      await service.detach();
      expect(unsubscribes[1]).toHaveBeenCalled();
    });

    /**
     * BST-1654 follow-up (review round 4): `detach()` deliberately spares the
     * durable run, which means the enqueue now resolves normally on a service
     * the requester has already torn down. Publishing from that continuation
     * re-arms `activeBackfill` and an "embedding pending" status after the
     * progress subscription is gone, so the completion event can never land and
     * the discarded service leaves a finished run on screen forever.
     */
    it('publishes nothing from an enqueue that resolves after the requester detached', async () => {
      let releaseEnqueue: () => void = () => undefined;
      const enqueueLanded = new Promise<void>((resolve) => {
        releaseEnqueue = resolve;
      });
      const deps = createDeps({
        enqueueBackfill: vi.fn(async () => {
          await enqueueLanded;
          return { requestId: 'background-indexing-backfill:detached' };
        }) as unknown as WorkspaceCollectionSyncServiceDependencies['enqueueBackfill'],
        fileContentProcessor: {
          processFiles: vi.fn(async () => ({
            [COMPOSITE_KEY]: { content: 'export const value = 1;', status: 'accessible' as const },
          })),
        },
        getBackfillsInFlight: vi.fn(async () => []),
        subscribeToBackfillProgress: vi.fn(() => () => {}),
      });
      const service = new WorkspaceCollectionSyncService(deps);

      const syncing = service.sync({
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-1',
        rootDirectoryHandle: createRootHandle(ROOT_PATH),
      });
      await vi.waitFor(() => expect(deps.enqueueBackfill).toHaveBeenCalled());

      await service.detach();
      releaseEnqueue();
      await syncing;

      expect(deps.setStatus).not.toHaveBeenCalledWith(
        expect.objectContaining({ backfillRequestId: 'background-indexing-backfill:detached' })
      );
      // Detach releases only local work: the durable run must survive it.
      expect(deps.cancelBackfill).not.toHaveBeenCalled();
    });
  });
});
