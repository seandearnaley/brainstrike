import type { EmbeddingSet } from '@brainstrike/db';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import {
  __resetBackgroundWorkArbiterForTests,
  acquireBackgroundWorkPauseReason,
  encodeFileSelection,
  getBackgroundWorkArbiterSnapshot,
} from '@brainstrike/utils';
import { QUEUE_DRAINED_EVENT } from '@brainstrike/utils/browser-events';
import {
  addLogListener,
  configureLogger,
  LogLevel,
  type LogRecord,
  setLogLevel,
} from '@brainstrike/utils/logger';
import type {
  WorkspaceIndexingQosInputs,
  WorkspaceIndexingQosPolicy,
} from '@brainstrike/utils/workspace-indexing-qos';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantForegroundActivityForTests,
  acquireAssistantForegroundActivity,
} from '../../assistant-foreground-activity';
import { boundBackgroundPermitWait } from '../background-permit-wait';
import { WorkspaceCollectionSyncProvider } from '../workspace-collection-sync-provider';
import { WorkspaceCollectionSyncService } from '../workspace-collection-sync-service';
import { WorkspaceIndexBlockedError } from '../workspace-index-blocked-error';
import { shouldExposeWorkspaceIndexDebugApi } from '../workspace-index-debug-harness';

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

const {
  runEnhancedImportMock,
  readFullTreeWithOptionsMock,
  processFilesMock,
  listManagedCacheEntryMetadataMock,
  applyManagedCacheBatchLocalMock,
  invalidateManagedCacheEntriesByIdentityLocalMock,
  updateMock,
  deleteByFileRecordIdMock,
  getByIdMock,
  getOrCreateWorkspaceIndexSetMock,
  createPriorityDbHandleMock,
  validateApiKeyForSetMock,
  ensureChunkingWorkerMock,
  ensureEmbeddingRuntimeStartedMock,
  completeEmbeddingChunkBatchMock,
  enqueueBackfillMock,
  cancelBackfillMock,
  dbState,
  vectorQueueServiceState,
  fileSystemState,
  fileTreeContextState,
  idleSchedulerSnapshot,
  resolveWorkspaceIndexingQosPolicyMock,
  registerRootMock,
  resolveDbRootIdMock,
} = vi.hoisted(() => ({
  applyManagedCacheBatchLocalMock: vi.fn(
    async (db: {
      transaction?: (
        fn: (tx: { query: ReturnType<typeof vi.fn> }) => Promise<void>
      ) => Promise<void>;
    }) => {
      await db.transaction?.(async () => undefined);
    }
  ),
  cancelBackfillMock: vi.fn(async () => {}),
  completeEmbeddingChunkBatchMock: vi.fn(),
  createPriorityDbHandleMock: vi.fn(
    (
      db: {
        exec?: ReturnType<typeof vi.fn>;
        query: ReturnType<typeof vi.fn>;
        transaction?: ReturnType<typeof vi.fn>;
      },
      priority: 'foreground' | 'normal' | 'background'
    ) => ({
      exec: vi.fn(async (sql: string, params?: unknown[]) =>
        db.exec
          ? await (db.exec as unknown as (...args: unknown[]) => Promise<unknown>)(sql, params, {
              priority,
            })
          : undefined
      ),
      query: vi.fn(
        async (sql: string, params?: unknown[]) =>
          await (db.query as unknown as (...args: unknown[]) => Promise<unknown>)(sql, params, {
            priority,
          })
      ),
      transaction: vi.fn(async (fn: (tx: { query: ReturnType<typeof vi.fn> }) => unknown) => {
        if (!db.transaction) {
          return;
        }
        return await (db.transaction as unknown as (...args: unknown[]) => Promise<unknown>)(
          async (tx: { query: ReturnType<typeof vi.fn> }) =>
            fn({
              query: vi.fn(
                async (sql: string, params?: unknown[]) =>
                  await (tx.query as unknown as (...args: unknown[]) => Promise<unknown>)(
                    sql,
                    params,
                    { priority }
                  )
              ),
            })
        );
      }),
    })
  ),
  dbState: {
    current: {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (fn: (tx: { query: ReturnType<typeof vi.fn> }) => unknown) =>
        fn({ query: vi.fn(async () => ({ rows: [] })) })
      ),
    } as {
      exec: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      transaction: ReturnType<typeof vi.fn>;
    } | null,
  },
  deleteByFileRecordIdMock: vi.fn(),
  enqueueBackfillMock: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
  ensureChunkingWorkerMock: vi.fn(),
  ensureEmbeddingRuntimeStartedMock: vi.fn(),
  fileSystemState: {
    isAccessLoading: false,
    rootDirectoryHandle: {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    } as {
      kind: string;
      name: string;
      path: string;
      platform: string;
      rootId?: string;
    } | null,
    rootDirectoryHandles: [
      {
        kind: 'directory',
        name: 'workspace',
        path: '/workspace/root',
        platform: 'electron',
      },
    ] as Array<{
      kind: string;
      name: string;
      path: string;
      platform: string;
      rootId?: string;
    }>,
    rootIdByPath: new Map<string, string>([['/workspace/root', 'root-id-1']]),
  },
  fileTreeContextState: {
    current: {
      isLoading: false,
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
    } as {
      isLoading: boolean;
      isRestorationSettled: boolean;
      isRestoringExpandedPaths: boolean;
      restorationProgress: null;
    } | null,
  },
  getByIdMock: vi.fn(),
  getOrCreateWorkspaceIndexSetMock: vi.fn(),
  idleSchedulerSnapshot: {
    backgroundWaiting: false,
    backgroundWaitingSince: null,
    backgroundYieldCount: 0,
    currentBackgroundWaitMs: 0,
    foregroundQuietMs: 75,
    lastBackgroundYieldAt: null,
    lastCompletedAt: null,
    lastForegroundAt: null,
    lastNormalAt: null,
    lastStartedAt: null,
    priorityStats: {
      background: {
        completed: 0,
        lastCompletedLabel: null,
        lastStartedLabel: null,
        longestWaitMs: 0,
        queued: 0,
        serviceP50Ms: 0,
        serviceP95Ms: 0,
        started: 0,
        totalServiceMs: 0,
        totalWaitMs: 0,
        waitP50Ms: 0,
        waitP95Ms: 0,
      },
      foreground: {
        completed: 0,
        lastCompletedLabel: null,
        lastStartedLabel: null,
        longestWaitMs: 0,
        queued: 0,
        serviceP50Ms: 0,
        serviceP95Ms: 0,
        started: 0,
        totalServiceMs: 0,
        totalWaitMs: 0,
        waitP50Ms: 0,
        waitP95Ms: 0,
      },
      normal: {
        completed: 0,
        lastCompletedLabel: null,
        lastStartedLabel: null,
        longestWaitMs: 0,
        queued: 0,
        serviceP50Ms: 0,
        serviceP95Ms: 0,
        started: 0,
        totalServiceMs: 0,
        totalWaitMs: 0,
        waitP50Ms: 0,
        waitP95Ms: 0,
      },
    },
    queued: {
      background: 0,
      foreground: 0,
      normal: 0,
    },
    runningLabel: null,
    runningPriority: null,
    snapshotAt: 1000,
  },
  invalidateManagedCacheEntriesByIdentityLocalMock: vi.fn(async () => ({
    canceledEmbeddingJobCount: 0,
    deletedChunkIds: [],
    deletedFileRecordIds: [],
  })),
  listManagedCacheEntryMetadataMock: vi.fn(),
  processFilesMock: vi.fn(),
  readFullTreeWithOptionsMock: vi.fn(),
  registerRootMock: vi.fn(async (_descriptor: unknown) => undefined),
  // Non-null by default: managed-cache identity is root_id (source_root_path
  // retired); a null dbRootId now skips the import, which would stall these
  // integration tests that assert the full sync runs.
  resolveDbRootIdMock: vi.fn(async (_rootPath: string): Promise<string | null> => 'db-root-id'),
  resolveWorkspaceIndexingQosPolicyMock: vi.fn(),
  runEnhancedImportMock: vi.fn(),
  updateMock: vi.fn(),
  validateApiKeyForSetMock: vi.fn(),
  vectorQueueServiceState: {
    current: {
      validateApiKeyForSet: vi.fn(),
    } as {
      validateApiKeyForSet: ReturnType<typeof vi.fn>;
    } | null,
  },
}));

vi.mock('@brainstrike/utils/workspace-indexing-qos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/workspace-indexing-qos')>();
  resolveWorkspaceIndexingQosPolicyMock.mockImplementation(
    (inputs: WorkspaceIndexingQosInputs): WorkspaceIndexingQosPolicy =>
      actual.resolveWorkspaceIndexingQosPolicy(inputs)
  );
  return {
    ...actual,
    resolveWorkspaceIndexingQosPolicy: resolveWorkspaceIndexingQosPolicyMock,
  };
});

vi.mock('@brainstrike/db', () => ({
  applyManagedCacheBatch: applyManagedCacheBatchLocalMock,
  createDatabasePressureController: vi.fn(() => ({
    waitForBackgroundPermit: vi.fn(async () => undefined),
  })),
  createPriorityDbHandle: createPriorityDbHandleMock,
  ElectronEmbeddingSetsRepository: vi.fn(function MockElectronEmbeddingSetsRepository() {
    return {
      getById: getByIdMock,
      getOrCreateWorkspaceIndexSet: getOrCreateWorkspaceIndexSetMock,
    };
  }),
  ElectronFileChunkRepository: vi.fn(function MockElectronFileChunkRepository() {
    return {
      deleteByFileRecordId: deleteByFileRecordIdMock,
      getCoverageForSet: vi.fn(async () => ({
        embeddedChunks: 0,
        totalChunks: 0,
      })),
      update: vi.fn(),
    };
  }),
  ElectronFileRecordRepository: vi.fn(function MockElectronFileRecordRepository() {
    return {
      listManagedCacheEntryMetadata: listManagedCacheEntryMetadataMock,
      update: updateMock,
    };
  }),
  getDatabasePressureWaitingReason: vi.fn(() => null),
  getDatabaseWorkScheduler: vi.fn(() => ({
    getSnapshot: vi.fn(() => idleSchedulerSnapshot),
    run: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  })),
  invalidateManagedCacheEntriesByIdentity: invalidateManagedCacheEntriesByIdentityLocalMock,
  JobQueue: vi.fn(function MockJobQueue() {
    return {
      clear: vi.fn(),
      completeEmbeddingChunkBatch: completeEmbeddingChunkBatchMock,
      enqueueBatch: vi.fn(),
      getQueueStats: vi.fn(async () => []),
      requeueFailed: vi.fn(),
    };
  }),
  usePGliteDatabase: () => dbState.current,
  WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS: {
    dimensions: 384,
    modelId: 'Xenova/all-MiniLM-L6-v2',
    modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  },
  WORKSPACE_INDEX_SYSTEM_ROLE: 'workspace-index',
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  createFileContentProcessor: () => ({
    processFiles: processFilesMock,
  }),
  useAdapters: () => ({
    fileSystemAdapter: { readDirectory: vi.fn(), readFile: vi.fn() },
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  createFileExplorerRefreshEvent: (detail: unknown) =>
    new CustomEvent('brainstrike:file-explorer-refreshed', { detail }),
  FILE_EXPLORER_REFRESH_EVENT: 'brainstrike:file-explorer-refreshed',
  useFileSystem: () => ({
    isAccessLoading: fileSystemState.isAccessLoading,
    rootDirectoryHandle: fileSystemState.rootDirectoryHandle,
    rootDirectoryHandles: fileSystemState.rootDirectoryHandles,
    rootIdByPath: fileSystemState.rootIdByPath,
  }),
}));

vi.mock('../../roots/use-roots-reconciliation', () => ({
  useRootsReconciliation: () => ({
    dbRootIdByAdapterRootId: new Map<string, string>(),
    registerRoot: registerRootMock,
    resolveDbRootId: resolveDbRootIdMock,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/tree', () => ({
  readFullTreeWithOptions: readFullTreeWithOptionsMock,
  useOptionalFileTreeContext: () => fileTreeContextState.current,
}));

vi.mock('@brainstrike/file-import/chunking-worker-context', () => ({
  useChunkingWorkerContext: () => ({
    ensureStarted: ensureChunkingWorkerMock,
    port: {
      isReady: () => true,
      transportKind: 'local',
    },
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
      cancelBackfill: cancelBackfillMock,
      enqueueBackfill: enqueueBackfillMock,
      ensureStarted: ensureEmbeddingRuntimeStartedMock,
      getBackfillsInFlight: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:test',
        runtimeKind: 'embedding-host',
        state: 'running',
      })),
      onBackfillProgress: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      reset: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:test',
        runtimeKind: 'embedding-host',
        state: 'running',
      })),
      start: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:test',
        runtimeKind: 'embedding-host',
        state: 'running',
      })),
      stop: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:test',
        runtimeKind: 'embedding-host',
        state: 'stopped',
      })),
    },
    service: vectorQueueServiceState.current ?? null,
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
    fileSystemState.rootDirectoryHandles = [
      {
        kind: 'directory',
        name: 'workspace',
        path: '/workspace/root',
        platform: 'electron',
      },
    ];
    fileSystemState.rootIdByPath = new Map<string, string>([['/workspace/root', 'root-id-1']]);
    fileTreeContextState.current = {
      isLoading: false,
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
    };
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetAssistantForegroundActivityForTests();
    __resetBackgroundWorkArbiterForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
    dbState.current = {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
    vectorQueueServiceState.current = {
      validateApiKeyForSet: validateApiKeyForSetMock,
    };

    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      mode: 'root-folder-cache',
    });

    const collection: EmbeddingSet = {
      createdAt: new Date().toISOString(),
      dimensions: 1536,
      distance: 'cosine',
      id: '00000000-0000-0000-0000-000000000101',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      name: 'Managed Cache',
      systemRole: 'workspace-index',
    };

    getByIdMock.mockResolvedValue(collection);
    getOrCreateWorkspaceIndexSetMock.mockResolvedValue(collection);
    resolveDbRootIdMock.mockImplementation(
      async (_rootPath: string): Promise<string | null> => 'db-root-id'
    );
    validateApiKeyForSetMock.mockResolvedValue({ valid: true });
    ensureChunkingWorkerMock.mockResolvedValue({
      chunkBatch: vi.fn(),
      chunkFile: vi.fn(),
      isReady: () => true,
      terminate: vi.fn(),
      transportKind: 'host-proxy',
    });
    ensureEmbeddingRuntimeStartedMock.mockResolvedValue({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:test',
      runtimeKind: 'embedding-host',
      state: 'running',
    });
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: '/workspace/root/src/index.ts', platform: 'electron' },
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        rootFolderId: '/workspace/root',
        type: 'file',
      },
    ]);
    processFilesMock.mockResolvedValue({
      [encodeFileSelection('/workspace/root', 'src/index.ts')]: 'export const value = 1;',
    });
    listManagedCacheEntryMetadataMock.mockResolvedValue([]);
    runEnhancedImportMock.mockImplementation(async (params) => {
      await params.baseImportRunner({
        fileContents: params.request.fileContents,
        fileTree: params.request.fileTree,
        onProgress: () => {},
        selectedFilePaths: params.request.selectedFilePaths,
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
    await waitFor(() => expect(applyManagedCacheBatchLocalMock).toHaveBeenCalledTimes(1));
    expect(createPriorityDbHandleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.any(Function),
      }),
      'background'
    );
    expect(applyManagedCacheBatchLocalMock.mock.calls[0]?.[0]).not.toBe(dbState.current);
    expect(enqueueBackfillMock).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000101',
      expect.objectContaining({
        source: 'background-indexing',
      })
    );
    expect(useWorkspaceCollectionSyncStatusStore.getState().managedCollectionName).toBe(
      'Managed Cache'
    );
  });

  it('coalesces refresh events while a background sync is already importing', async () => {
    const resolveImportRef: { current: (() => void) | null } = { current: null };
    const importStarted = new Promise<void>((resolve) => {
      runEnhancedImportMock.mockImplementationOnce(async (params) => {
        await params.baseImportRunner({
          fileContents: params.request.fileContents,
          fileTree: params.request.fileTree,
          onProgress: () => {},
          selectedFilePaths: params.request.selectedFilePaths,
        });
        resolve();
        await new Promise<void>((finish) => {
          resolveImportRef.current = finish;
        });
        return [];
      });
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await importStarted;
    expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new CustomEvent('brainstrike:file-explorer-refreshed'));
    await waitFor(() => expect(resolveImportRef.current).not.toBeNull());
    const resolveImport = resolveImportRef.current;
    if (!resolveImport) {
      throw new Error('Import resolver was not captured.');
    }

    expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);

    resolveImport();
    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(2));
  });

  it('uses the desktop power snapshot for QoS policy inputs when available', async () => {
    Object.assign(window, {
      power: {
        getSnapshot: vi.fn(async () => ({
          idleState: 'idle',
          idleTimeMs: 90_000,
          powerSource: 'battery',
          sampledAt: 1234,
          thermalState: 'serious',
        })),
        onPowerState: vi.fn(() => () => {}),
      },
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
          expect.objectContaining({
            idleState: 'idle',
            idleTimeMs: 90_000,
            powerSource: 'battery',
            thermalState: 'serious',
          })
        )
      );
    } finally {
      Reflect.deleteProperty(window, 'power');
    }
  });

  it('passes foreground assistant activity into Workspace Index QoS inputs', async () => {
    const foregroundActivityLease = acquireAssistantForegroundActivity();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
          expect.objectContaining({
            foregroundQueryActive: true,
          })
        )
      );
    } finally {
      foregroundActivityLease.release();
    }
  });

  it('passes measured queue depth and renderer memory pressure into Workspace Index QoS inputs', async () => {
    Object.defineProperty(globalThis.performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: 100,
        usedJSHeapSize: 80,
      },
    });
    dbState.current?.query.mockImplementationOnce(async () => ({ rows: [{ count: 42 }] }));

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalledWith(
          expect.objectContaining({
            pipeline: expect.objectContaining({
              accelerator: { available: false },
              memory: {
                available: true,
                pressure: 'high',
                retainedHeapRatio: 0.8,
              },
              progress: { available: false },
              queueDepth: {
                activeEmbeddingJobs: 42,
                available: true,
              },
            }),
          })
        )
      );
    } finally {
      Reflect.deleteProperty(globalThis.performance, 'memory');
    }
  });

  it('logs a workspace QoS transition once across repeated policy resolutions', async () => {
    configureLogger({ enableInProduction: true });
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (
        record.scope === 'WorkspaceIndexingQos' &&
        record.message === 'Workspace indexing QoS state changed'
      ) {
        captured.push(record);
      }
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(resolveWorkspaceIndexingQosPolicyMock).toHaveBeenCalled());

      // A single shared transition tracker must dedupe identical observations.
      expect(captured).toHaveLength(1);
      expect(captured[0]?.args).toContainEqual(expect.objectContaining({ from: null }));
    } finally {
      removeListener();
      // Restore the default so later tests in this file stay console-quiet.
      configureLogger({ enableInProduction: false });
    }
  });

  it('caches desktop power snapshots across QoS retry loops', async () => {
    const getSnapshotMock = vi.fn(async () => ({
      idleState: 'idle',
      idleTimeMs: 90_000,
      powerSource: 'battery',
      sampledAt: Date.now(),
      thermalState: 'nominal',
    }));
    const foregroundYieldingPolicy = createTestQosPolicy({
      allowNewWork: false,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 0,
      contentReadBatchSize: 0,
      contentReadConcurrency: 0,
      importBatchSize: 0,
      interBatchDelayMs: 1,
      progressThrottleMs: 1,
      reason: 'foreground-db-pressure',
      scanBatchSize: 0,
      state: 'foreground-yielding',
      workerClaimBatchSize: 0,
    });
    const balancedPolicy = createTestQosPolicy({
      allowNewWork: true,
      allowPowerSaveBlocker: false,
      backfillQueueDepth: 128,
      contentReadBatchSize: 32,
      contentReadConcurrency: 2,
      importBatchSize: 25,
      interBatchDelayMs: 75,
      progressThrottleMs: 250,
      reason: 'balanced',
      scanBatchSize: 250,
      state: 'balanced',
      workerClaimBatchSize: 1,
    });
    resolveWorkspaceIndexingQosPolicyMock
      .mockReturnValueOnce(foregroundYieldingPolicy)
      .mockReturnValue(balancedPolicy);
    Object.assign(window, {
      power: {
        getSnapshot: getSnapshotMock,
        onPowerState: vi.fn(() => () => {}),
      },
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(resolveWorkspaceIndexingQosPolicyMock.mock.calls.length).toBeGreaterThanOrEqual(2)
      );

      expect(getSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(window, 'power');
    }
  });

  it('creates and syncs the default workspace index when fresh preferences have no managed collection', async () => {
    const workspaceIndex: EmbeddingSet = {
      createdAt: new Date().toISOString(),
      dimensions: 1536,
      distance: 'cosine',
      id: '00000000-0000-0000-0000-000000000202',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      name: 'Workspace Index',
      systemRole: 'workspace-index',
    };
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
    });
    getOrCreateWorkspaceIndexSetMock.mockResolvedValueOnce(workspaceIndex);
    getByIdMock.mockResolvedValue(workspaceIndex);

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(getOrCreateWorkspaceIndexSetMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe(
        workspaceIndex.id
      )
    );
    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));

    expect(validateApiKeyForSetMock).toHaveBeenCalledWith(workspaceIndex.id);
    await waitFor(() =>
      expect(enqueueBackfillMock).toHaveBeenCalledWith(
        workspaceIndex.id,
        expect.objectContaining({
          source: 'background-indexing',
        })
      )
    );
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
      expect.objectContaining({
        managedCollectionId: workspaceIndex.id,
        managedCollectionName: 'Workspace Index',
      })
    );
  });

  it('bootstraps when persist hydration completed but the store marker is stale', async () => {
    const workspaceIndex: EmbeddingSet = {
      createdAt: new Date().toISOString(),
      dimensions: 1536,
      distance: 'cosine',
      id: '00000000-0000-0000-0000-000000000252',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      name: 'Workspace Index',
      systemRole: 'workspace-index',
    };
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: false,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
    });
    const persistApi = (
      useBackgroundIndexingPreferencesStore as typeof useBackgroundIndexingPreferencesStore & {
        persist?: { hasHydrated?: () => boolean };
      }
    ).persist;
    if (!persistApi?.hasHydrated) {
      throw new Error('background indexing preferences persist API unavailable');
    }
    vi.spyOn(persistApi, 'hasHydrated').mockReturnValue(true);
    getOrCreateWorkspaceIndexSetMock.mockResolvedValueOnce(workspaceIndex);
    getByIdMock.mockResolvedValue(workspaceIndex);

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(getOrCreateWorkspaceIndexSetMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
        hasHydrated: true,
        managedCollectionId: workspaceIndex.id,
      })
    );
    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
  });

  it('rehydrates its own background preferences before bootstrapping', async () => {
    const workspaceIndex: EmbeddingSet = {
      createdAt: new Date().toISOString(),
      dimensions: 1536,
      distance: 'cosine',
      id: '00000000-0000-0000-0000-000000000253',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      name: 'Workspace Index',
      systemRole: 'workspace-index',
    };
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: false,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
    });
    const persistApi = (
      useBackgroundIndexingPreferencesStore as typeof useBackgroundIndexingPreferencesStore & {
        persist?: {
          hasHydrated?: () => boolean;
          rehydrate?: () => Promise<void>;
        };
      }
    ).persist;
    if (!(persistApi?.hasHydrated && persistApi.rehydrate)) {
      throw new Error('background indexing preferences persist API unavailable');
    }
    let persistHydrated = false;
    vi.spyOn(persistApi, 'hasHydrated').mockImplementation(() => persistHydrated);
    vi.spyOn(persistApi, 'rehydrate').mockImplementation(async () => {
      persistHydrated = true;
      useBackgroundIndexingPreferencesStore.setState({
        hasHydrated: true,
      });
    });
    getOrCreateWorkspaceIndexSetMock.mockResolvedValueOnce(workspaceIndex);
    getByIdMock.mockResolvedValue(workspaceIndex);

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(persistApi.rehydrate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getOrCreateWorkspaceIndexSetMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
        hasHydrated: true,
        managedCollectionId: workspaceIndex.id,
      })
    );
    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
  });

  it('dedupes workspace index bootstrap while collection creation is in flight', async () => {
    const workspaceIndex: EmbeddingSet = {
      createdAt: new Date().toISOString(),
      dimensions: 384,
      distance: 'cosine',
      id: '00000000-0000-0000-0000-000000000202',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      name: 'Workspace Index',
      systemRole: 'workspace-index',
    };
    let resolveBootstrap: (collection: EmbeddingSet) => void;
    const bootstrapPromise = new Promise<EmbeddingSet>((resolve) => {
      resolveBootstrap = resolve;
    });
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
    });
    getOrCreateWorkspaceIndexSetMock.mockReturnValue(bootstrapPromise);
    getByIdMock.mockResolvedValue(workspaceIndex);

    let releasePause: (() => void) | undefined;
    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(getOrCreateWorkspaceIndexSetMock).toHaveBeenCalledTimes(1));

      await act(async () => {
        releasePause = await acquireBackgroundWorkPauseReason('local-llm');
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(getOrCreateWorkspaceIndexSetMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveBootstrap(workspaceIndex);
        await bootstrapPromise;
      });
      await waitFor(() =>
        expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe(
          workspaceIndex.id
        )
      );
    } finally {
      releasePause?.();
    }
  });

  it('preserves manual pause while bootstrapping fresh workspace index preferences', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: true,
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe(
        '00000000-0000-0000-0000-000000000101'
      )
    );
    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          pauseReasons: ['Paused manually'],
          state: 'paused',
        })
      )
    );

    expect(validateApiKeyForSetMock).not.toHaveBeenCalled();
    expect(ensureEmbeddingRuntimeStartedMock).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(enqueueBackfillMock).not.toHaveBeenCalled();
  });

  it('does not raise the foreground isImporting pause flag during background indexing', async () => {
    // Regression: background indexing used to set the global `isImporting` flag,
    // which gates the collection selector + count live queries (liveQueryEnabled =
    // !isImporting). That froze the file/chunk counts at their stale value (0/0)
    // for the entire background import. Background work must report progress via
    // the workspace-sync status store, never via the foreground pause flag.
    __resetVectorStatusUIStoreForTests();
    const observedImporting: boolean[] = [];
    const unsubscribe = useVectorStatusUIStore.subscribe((state) => {
      observedImporting.push(state.isImporting);
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(applyManagedCacheBatchLocalMock).toHaveBeenCalledTimes(1));
    } finally {
      unsubscribe();
    }

    expect(observedImporting).not.toContain(true);
    expect(useVectorStatusUIStore.getState().isImporting).toBe(false);
  });

  it('uses the electron managed-cache batch bridge when it is available', async () => {
    const electronApplyManagedCacheBatch = vi.fn(async () => undefined);
    Object.assign(window, {
      electronAPI: {
        db: {
          applyManagedCacheBatch: electronApplyManagedCacheBatch,
        },
      },
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(electronApplyManagedCacheBatch).toHaveBeenCalledTimes(1));
      expect(electronApplyManagedCacheBatch).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          priority: 'background',
        })
      );
      expect(applyManagedCacheBatchLocalMock).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });

  it('routes typed watcher incremental refreshes only to matching active root handles', async () => {
    const rootA = {
      kind: 'directory',
      name: 'root-a',
      path: '/workspace/root-a',
      platform: 'electron',
      rootId: 'root-a-id',
    };
    fileSystemState.rootDirectoryHandle = rootA;
    fileSystemState.rootDirectoryHandles = [
      rootA,
      {
        kind: 'directory',
        name: 'root-b',
        path: '/workspace/root-b',
        platform: 'electron',
        rootId: 'root-b-id',
      },
    ];
    fileSystemState.rootIdByPath = new Map([
      ['/workspace/root-a', 'root-a-id'],
      ['/workspace/root-b', 'root-b-id'],
    ]);
    resolveDbRootIdMock.mockImplementation(async (_rootPath: string, rootId?: string | null) =>
      rootId === 'root-b-id' ? 'db-root-b-id' : 'db-root-a-id'
    );
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      syncSpy.mockClear();

      const change = {
        kind: 'file' as const,
        path: '/workspace/root-b/src/index.ts',
        type: 'modified' as const,
      };
      act(() => {
        window.dispatchEvent(
          new CustomEvent('brainstrike:file-explorer-refreshed', {
            detail: {
              roots: [
                {
                  changes: [change],
                  rootId: 'root-b-id',
                  rootPath: '/workspace/root-b',
                },
              ],
              scope: 'incremental',
              source: 'watcher',
            },
          })
        );
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dbRootId: 'db-root-b-id',
          rootDirectoryHandle: expect.objectContaining({
            path: '/workspace/root-b',
            rootId: 'root-b-id',
          }),
          scope: {
            changes: [change],
            mode: 'paths',
          },
        })
      );
      expect(resolveDbRootIdMock).toHaveBeenLastCalledWith('/workspace/root-b', 'root-b-id');
    } finally {
      syncSpy.mockRestore();
    }
  });

  it("scopes a watcher overflow event (scope 'full' with named roots) to a full resync of ONLY the affected root", async () => {
    const rootA = {
      kind: 'directory',
      name: 'root-a',
      path: '/workspace/root-a',
      platform: 'electron',
      rootId: 'root-a-id',
    };
    fileSystemState.rootDirectoryHandle = rootA;
    fileSystemState.rootDirectoryHandles = [
      rootA,
      {
        kind: 'directory',
        name: 'root-b',
        path: '/workspace/root-b',
        platform: 'electron',
        rootId: 'root-b-id',
      },
    ];
    fileSystemState.rootIdByPath = new Map([
      ['/workspace/root-a', 'root-a-id'],
      ['/workspace/root-b', 'root-b-id'],
    ]);
    resolveDbRootIdMock.mockImplementation(async (_rootPath: string, rootId?: string | null) =>
      rootId === 'root-b-id' ? 'db-root-b-id' : 'db-root-a-id'
    );
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      syncSpy.mockClear();

      // Watcher overflow: 'unknown' observer records mean events may have been
      // missed for root-b — dispatched as scope 'full' with the affected root.
      act(() => {
        window.dispatchEvent(
          new CustomEvent('brainstrike:file-explorer-refreshed', {
            detail: {
              roots: [{ changes: [], rootId: 'root-b-id', rootPath: '/workspace/root-b' }],
              scope: 'full',
              source: 'watcher',
            },
          })
        );
      });

      // Exactly ONE sync — for root-b, with a FULL per-root scope. Root-a is
      // untouched: overflow must not fan out workspace-wide.
      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dbRootId: 'db-root-b-id',
          rootDirectoryHandle: expect.objectContaining({
            path: '/workspace/root-b',
            rootId: 'root-b-id',
          }),
          scope: { mode: 'full' },
        })
      );
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('treats payloadless and invalid refresh events as full all-root recovery syncs', async () => {
    const rootA = {
      kind: 'directory',
      name: 'root-a',
      path: '/workspace/root-a',
      platform: 'electron',
      rootId: 'root-a-id',
    };
    fileSystemState.rootDirectoryHandle = rootA;
    fileSystemState.rootDirectoryHandles = [
      rootA,
      {
        kind: 'directory',
        name: 'root-b',
        path: '/workspace/root-b',
        platform: 'electron',
        rootId: 'root-b-id',
      },
    ];
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      syncSpy.mockClear();

      act(() => {
        window.dispatchEvent(new Event('brainstrike:file-explorer-refreshed'));
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      expect(syncSpy.mock.calls.map(([request]) => request.rootDirectoryHandle?.path)).toEqual([
        '/workspace/root-a',
        '/workspace/root-b',
      ]);
      expect(syncSpy.mock.calls.every(([request]) => request.scope?.mode === 'full')).toBe(true);

      syncSpy.mockClear();
      act(() => {
        window.dispatchEvent(
          new CustomEvent('brainstrike:file-explorer-refreshed', {
            detail: { roots: 'invalid', scope: 'incremental', source: 'watcher' },
          })
        );
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      expect(syncSpy.mock.calls.map(([request]) => request.rootDirectoryHandle?.path)).toEqual([
        '/workspace/root-a',
        '/workspace/root-b',
      ]);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('runs a full follow-up sync when the managed workspace embedding queue drains', async () => {
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));
      syncSpy.mockClear();

      act(() => {
        window.dispatchEvent(
          new CustomEvent(QUEUE_DRAINED_EVENT, {
            detail: {
              embeddingSetId: '00000000-0000-0000-0000-000000000101',
              queue: 'embeddings',
            },
          })
        );
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          scope: { mode: 'full' },
        })
      );

      syncSpy.mockClear();
      act(() => {
        window.dispatchEvent(
          new CustomEvent(QUEUE_DRAINED_EVENT, {
            detail: {
              embeddingSetId: '00000000-0000-0000-0000-000000000999',
              queue: 'embeddings',
            },
          })
        );
      });

      expect(syncSpy).not.toHaveBeenCalled();
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('does not repeatedly trigger recovery syncs when idle coverage remains incomplete for the same roots', async () => {
    let coverageAuditCount = 0;
    dbState.current = {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT root_id, path')) {
          coverageAuditCount += 1;
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => expect(coverageAuditCount).toBeGreaterThanOrEqual(2));

      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('waiting');
      expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toContain(
        'Workspace Index coverage is incomplete after the pipeline reported idle'
      );
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('triggers another recovery sync when incomplete coverage changes for the same roots', async () => {
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: '/workspace/root/src/index.ts', platform: 'electron' },
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        rootFolderId: '/workspace/root',
        type: 'file',
      },
      {
        handle: { path: '/workspace/root/src/other.ts', platform: 'electron' },
        name: 'other.ts',
        path: '/workspace/root/src/other.ts',
        rootFolderId: '/workspace/root',
        type: 'file',
      },
    ]);
    let indexedPaths: string[] = [];
    dbState.current = {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT root_id, path')) {
          return {
            rows: indexedPaths.map((path) => ({ path, root_id: 'db-root-id' })),
          };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));

      indexedPaths = ['src/index.ts'];
      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(3));
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('allows another recovery sync after coverage was verified complete for the same roots', async () => {
    let indexedPaths: string[] = [];
    dbState.current = {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT root_id, path')) {
          return {
            rows: indexedPaths.map((path) => ({ path, root_id: 'db-root-id' })),
          };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));

      indexedPaths = ['src/index.ts'];
      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => {
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
          lastError: null,
          state: 'idle',
        });
      });

      indexedPaths = [];
      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: '/workspace/root/src/index.ts',
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 0,
          queuedFiles: 1,
          state: 'importing',
        });
      });

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(3));
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('treats files the import content gate refuses as covered by the idle audit', async () => {
    // Repro for the false "coverage is incomplete" loop: a file passes the
    // name/size entry policy (so it counts as expected) but its CONTENT can
    // never be indexed (null bytes). The audit must classify it as covered
    // instead of demanding a recovery sync that can never converge.
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: '/workspace/root/src/index.ts', platform: 'electron' },
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        rootFolderId: '/workspace/root',
        type: 'file',
      },
      {
        handle: {
          path: '/workspace/root/docs/binary-content.md',
          platform: 'electron',
        },
        name: 'binary-content.md',
        path: '/workspace/root/docs/binary-content.md',
        rootFolderId: '/workspace/root',
        type: 'file',
      },
    ]);
    processFilesMock.mockImplementation(
      async (requests: Array<{ compositeKey: string }>): Promise<Record<string, string>> =>
        Object.fromEntries(
          requests.map((request) => [
            request.compositeKey,
            request.compositeKey.includes('binary-content.md')
              ? 'looks like markdown but contains a null\0byte'
              : 'export const value = 1;',
          ])
        )
    );
    dbState.current = {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT root_id, path')) {
          return { rows: [{ path: 'src/index.ts', root_id: 'db-root-id' }] };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();
    configureLogger({ enableInProduction: true });
    setLogLevel(LogLevel.INFO);
    const capturedExclusionLogs: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (
        record.scope === 'WorkspaceCollectionSyncProvider' &&
        record.message?.includes('unindexable files excluded from coverage') === true
      ) {
        capturedExclusionLogs.push(record);
      }
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => {
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
          lastError: null,
          state: 'idle',
        });
      });
      // The unindexable file must not trigger a recovery sync.
      expect(syncSpy).toHaveBeenCalledTimes(1);
      // The audit publishes the count so the UI can show it without logs.
      expect(useWorkspaceCollectionSyncStatusStore.getState().unindexableFileCount).toBe(1);
      // Diagnostics name the file and the exact content-gate reason.
      expect(capturedExclusionLogs.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(capturedExclusionLogs[0]?.args ?? [])).toContain(
        'docs/binary-content.md'
      );
      expect(JSON.stringify(capturedExclusionLogs[0]?.args ?? [])).toContain('null bytes');
    } finally {
      removeListener();
      configureLogger({ enableInProduction: false });
      syncSpy.mockRestore();
    }
  });

  it('names genuinely missing files in the incomplete coverage error', async () => {
    readFullTreeWithOptionsMock.mockResolvedValue([
      {
        handle: { path: '/workspace/root/src/index.ts', platform: 'electron' },
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        rootFolderId: '/workspace/root',
        type: 'file',
      },
      {
        handle: { path: '/workspace/root/src/missed.ts', platform: 'electron' },
        name: 'missed.ts',
        path: '/workspace/root/src/missed.ts',
        rootFolderId: '/workspace/root',
        type: 'file',
      },
    ]);
    processFilesMock.mockImplementation(
      async (requests: Array<{ compositeKey: string }>): Promise<Record<string, string>> =>
        Object.fromEntries(
          requests.map((request) => [request.compositeKey, 'export const value = 1;'])
        )
    );
    dbState.current = {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT root_id, path')) {
          return { rows: [{ path: 'src/index.ts', root_id: 'db-root-id' }] };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      // One automatic recovery sync fires for the genuine gap.
      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: '/workspace/root',
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          pauseReasons: [],
          processedFiles: 1,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => {
        const status = useWorkspaceCollectionSyncStatusStore.getState();
        expect(status.state).toBe('waiting');
        expect(status.lastError).toContain(
          'Workspace Index coverage is incomplete after the pipeline reported idle'
        );
        expect(status.lastError).toContain('src/missed.ts');
      });
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('falls back to full recovery sync when a watcher event matches no active root', async () => {
    const rootA = {
      kind: 'directory',
      name: 'root-a',
      path: '/workspace/root-a',
      platform: 'electron',
      rootId: 'root-a-id',
    };
    fileSystemState.rootDirectoryHandle = rootA;
    fileSystemState.rootDirectoryHandles = [
      rootA,
      {
        kind: 'directory',
        name: 'root-b',
        path: '/workspace/root-b',
        platform: 'electron',
        rootId: 'root-b-id',
      },
    ];
    fileSystemState.rootIdByPath = new Map([
      ['/workspace/root-a', 'root-a-id'],
      ['/workspace/root-b', 'root-b-id'],
    ]);
    const syncSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'sync').mockResolvedValue();
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceCollectionSyncProvider') {
        captured.push(record);
      }
    });
    configureLogger({ enableInProduction: true });
    setLogLevel(LogLevel.WARN);

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      syncSpy.mockClear();

      act(() => {
        window.dispatchEvent(
          new CustomEvent('brainstrike:file-explorer-refreshed', {
            detail: {
              roots: [
                {
                  changes: [
                    { kind: 'file', path: '/workspace/removed/src/index.ts', type: 'modified' },
                  ],
                  rootId: 'removed-root-id',
                  rootPath: '/workspace/removed',
                },
              ],
              scope: 'incremental',
              source: 'watcher',
            },
          })
        );
      });

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      expect(syncSpy.mock.calls.every(([request]) => request.scope?.mode === 'full')).toBe(true);
      expect(captured).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message:
            'Watcher refresh referenced no active workspace roots; running full recovery sync',
        })
      );
    } finally {
      removeListener();
      configureLogger({ enableInProduction: false });
      syncSpy.mockRestore();
    }
  });

  it('surfaces sync failures instead of leaving rejected background promises unhandled', async () => {
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockRejectedValueOnce(new Error('Synthetic sync failure'));
    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
          expect.objectContaining({
            lastError: 'Synthetic sync failure',
            state: 'error',
          })
        )
      );
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('surfaces non-Error sync failures with a null root path when no root handle exists', async () => {
    fileSystemState.rootDirectoryHandle = null;

    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockRejectedValueOnce('Synthetic string sync failure');

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
          expect.objectContaining({
            activeRootPath: null,
            lastError: 'Synthetic string sync failure',
            state: 'error',
          })
        )
      );
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('surfaces sync failures on the disabled-path sync branch as well', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: false,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
    });

    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockRejectedValueOnce(new Error('Synthetic disabled sync failure'));

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
          expect.objectContaining({
            lastError: 'Synthetic disabled sync failure',
            state: 'error',
          })
        )
      );
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('stops and resets status when background indexing is disabled', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: false,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
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

  it('rebinds a stale managed collection id to the workspace index', async () => {
    getByIdMock.mockResolvedValueOnce(null);

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe(
        '00000000-0000-0000-0000-000000000101'
      )
    );
    await waitFor(() => expect(getOrCreateWorkspaceIndexSetMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
    expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
      expect.objectContaining({
        managedCollectionId: '00000000-0000-0000-0000-000000000101',
        managedCollectionName: 'Managed Cache',
      })
    );
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

  it('aborts the active full-root scan before restarting with a changed policy', async () => {
    useBackgroundIndexingPreferencesStore.setState({ indexingPolicyPreset: 'full-root' });
    let firstRunSignal: AbortSignal | null = null;
    let firstImportStarted!: () => void;
    const firstImportStartedPromise = new Promise<void>((resolve) => {
      firstImportStarted = resolve;
    });
    runEnhancedImportMock
      .mockImplementationOnce(
        async (params) =>
          await new Promise<never>((_resolve, reject) => {
            firstRunSignal = params.abortSignal ?? null;
            firstImportStarted();
            params.abortSignal?.addEventListener(
              'abort',
              () => {
                const error = new Error('Superseded indexing policy');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true }
            );
          })
      )
      .mockResolvedValueOnce([]);

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );
    await firstImportStartedPromise;

    act(() => {
      useBackgroundIndexingPreferencesStore.getState().setIndexingPolicyPreset('balanced');
    });

    await waitFor(() => expect(firstRunSignal?.aborted).toBe(true));
    await waitFor(() => expect(readFullTreeWithOptionsMock).toHaveBeenCalledTimes(2));
    const fullRootPolicy = readFullTreeWithOptionsMock.mock.calls[0]?.[2]?.entryPolicy;
    const balancedPolicy = readFullTreeWithOptionsMock.mock.calls[1]?.[2]?.entryPolicy;
    expect(
      fullRootPolicy?.shouldTraverseDirectory({
        directoryName: 'venv',
        relativePath: 'augmentoolkit/venv',
      })
    ).toBe(true);
    expect(
      balancedPolicy?.shouldTraverseDirectory({
        directoryName: 'venv',
        relativePath: 'augmentoolkit/venv',
      })
    ).toBe(false);
  });

  it('waits for file explorer restoration to settle before starting background indexing', async () => {
    fileTreeContextState.current = {
      isLoading: false,
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
      isLoading: false,
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

  it('starts background indexing after the grace window even if file explorer restoration never settles', async () => {
    // A very large root (e.g. a 27k-file repo) can keep the file tree loading
    // for minutes. Tree restoration is only a convenience gate, so the indexer
    // must not stay wedged in "waiting" forever — after TREE_RESTORATION_GRACE_MS
    // it proceeds regardless of tree state. This is the real-world "added a
    // folder, nothing happened" failure that the grace timeout fixes.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fileTreeContextState.current = {
        isLoading: false,
        isRestorationSettled: false,
        isRestoringExpandedPaths: true,
        restorationProgress: null,
      };

      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('waiting')
      );
      expect(runEnhancedImportMock).not.toHaveBeenCalled();

      // Tree never settles; only the 5s grace timer elapses.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });

      await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses background indexing when the shared background-work arbiter is paused', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      mode: 'root-folder-cache',
      paused: true,
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          pauseReasons: ['Paused manually'],
          state: 'paused',
        })
      )
    );
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
  });

  it('auto-pauses background indexing when a foreground local-llm lease is active', async () => {
    const release = await acquireBackgroundWorkPauseReason('local-llm');
    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
          expect.objectContaining({
            pauseReasons: ['Paused for local assistant'],
            state: 'paused',
          })
        )
      );
      expect(runEnhancedImportMock).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('surfaces both manual and automatic pause reasons when they are active together', async () => {
    const release = await acquireBackgroundWorkPauseReason('local-llm');
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      mode: 'root-folder-cache',
      paused: true,
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() =>
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
          expect.objectContaining({
            pauseReasons: ['Paused manually', 'Paused for local assistant'],
            state: 'paused',
          })
        )
      );
    } finally {
      release();
    }
  });

  it('clears the manual arbiter pause when the provider unmounts', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      mode: 'root-folder-cache',
      paused: true,
    });

    const rendered = render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(getBackgroundWorkArbiterSnapshot()).toEqual(
        expect.objectContaining({
          backgroundIndexingPaused: true,
          manualPause: true,
        })
      )
    );

    rendered.unmount();

    expect(getBackgroundWorkArbiterSnapshot()).toEqual({
      automaticPauseReasons: [],
      backgroundIndexingPaused: false,
      manualPause: false,
    });
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

  it('waits for the shared tree to finish loading before starting background indexing', async () => {
    fileTreeContextState.current = {
      isLoading: true,
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
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
      isLoading: false,
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

  it('cancels an in-flight sync when restoration resumes after scanning has started', async () => {
    type TreeReadResult = Array<{
      handle: { path: string; platform: 'electron' };
      name: string;
      path: string;
      rootFolderId: string;
      type: 'file';
    }>;

    const resolveTreeReadRef: { current: ((value: TreeReadResult) => void) | null } = {
      current: null,
    };
    const pendingTreeRead = new Promise<TreeReadResult>((resolve) => {
      resolveTreeReadRef.current = resolve;
    });
    readFullTreeWithOptionsMock.mockReturnValueOnce(pendingTreeRead);

    const { rerender } = render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(readFullTreeWithOptionsMock).toHaveBeenCalledTimes(1));

    fileTreeContextState.current = {
      isLoading: false,
      isRestorationSettled: false,
      isRestoringExpandedPaths: true,
      restorationProgress: null,
    };
    rerender(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('waiting')
    );

    const resolveTreeRead = resolveTreeReadRef.current;
    if (resolveTreeRead === null) {
      throw new Error('Expected tree read resolver to be set');
    }
    resolveTreeRead([
      {
        handle: { path: '/workspace/root/src/index.ts', platform: 'electron' },
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        rootFolderId: '/workspace/root',
        type: 'file',
      },
    ]);

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(ensureEmbeddingRuntimeStartedMock).not.toHaveBeenCalled();
  });

  it('waits when shared runtime dependencies are not ready while enabled', async () => {
    dbState.current = null;

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          lastError: null,
          state: 'waiting',
        })
      )
    );
  });

  it('resets status when the runtime is unavailable but background indexing is disabled', async () => {
    dbState.current = null;
    useBackgroundIndexingPreferencesStore.setState({
      enabled: false,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          lastError: null,
          state: 'disabled',
        })
      )
    );
  });

  it('re-runs background sync when the file explorer refresh event fires', async () => {
    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new CustomEvent('brainstrike:file-explorer-refreshed'));
    });

    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(2));
  });

  it('keeps the sync service mounted when recent user input changes QoS inputs', async () => {
    const cancelSpy = vi.spyOn(WorkspaceCollectionSyncService.prototype, 'cancel');

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown'));
      });

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(runEnhancedImportMock).toHaveBeenCalledTimes(1);
    } finally {
      cancelSpy.mockRestore();
    }
  });

  it('surfaces cancel failures from provider cleanup', async () => {
    const cancelSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'cancel')
      .mockRejectedValueOnce(new Error('Synthetic cancel failure'));

    try {
      runEnhancedImportMock.mockImplementationOnce(
        async () => await new Promise<never>(() => undefined)
      );
      const rendered = render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
      rendered.unmount();

      await waitFor(() =>
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
          expect.objectContaining({
            lastError: 'Synthetic cancel failure',
            state: 'error',
          })
        )
      );
    } finally {
      cancelSpy.mockRestore();
    }
  });

  it('fails visibly when hosted-provider validation is unavailable', async () => {
    vectorQueueServiceState.current = null;

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          lastError: 'Vector queue service is unavailable.',
          state: 'error',
        })
      )
    );
  });

  it('blocks workspace indexing when provider validation reports a missing key', async () => {
    const missingKeyMessage =
      'OpenAI API key not configured. Please add your API key (OPENAI_API_KEY) in Settings → Secrets or set the environment variable.';
    validateApiKeyForSetMock.mockResolvedValueOnce({
      message: missingKeyMessage,
      reason: 'missing-provider-key',
      valid: false,
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          blockedReason: 'missing-provider-key',
          lastError: missingKeyMessage,
          state: 'blocked',
        })
      )
    );
    expect(ensureEmbeddingRuntimeStartedMock).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(enqueueBackfillMock).not.toHaveBeenCalled();
  });

  it('clears stale progress when bootstrap reports blocked indexing', async () => {
    const missingKeyMessage = 'OpenAI API key not configured.';
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
    });
    getOrCreateWorkspaceIndexSetMock.mockRejectedValueOnce(
      new WorkspaceIndexBlockedError('missing-provider-key', missingKeyMessage)
    );
    useWorkspaceCollectionSyncStatusStore.setState({
      activeRootPath: '/workspace/root',
      backfillRequestId: 'background-indexing-backfill:stale',
      chunkingProgress: {
        chunksCreated: 14,
        currentFile: 'src/stale.ts',
        filesProcessed: 3,
        strategyUsed: 'markdown',
        totalFiles: 8,
      },
      currentFilePath: 'src/stale.ts',
      embeddingProgress: {
        chunksProcessed: 2,
        currentChunk: 'stale chunk',
        modelName: 'text-embedding-3-small',
        totalChunks: 14,
      },
      importProgress: {
        completed: 4,
        current: 'src/stale.ts',
        errorCount: 0,
        total: 8,
      },
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      managedCollectionName: 'Managed Cache',
      pauseReasons: ['Paused manually'],
      processedFiles: 4,
      queuedFiles: 12,
      queueProgress: {
        failed: 0,
        lastError: null,
        lastEvent: null,
        pending: 12,
        processed: 2,
        totalQueued: 14,
      },
      scanSummary: {
        changedFiles: 8,
        discoveredFiles: 20,
        excludedEntries: 2,
        unchangedFiles: 10,
      },
      state: 'importing',
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          backfillRequestId: null,
          blockedReason: 'missing-provider-key',
          chunkingProgress: null,
          currentFilePath: null,
          embeddingProgress: null,
          importProgress: null,
          lastError: missingKeyMessage,
          pauseReasons: [],
          processedFiles: 0,
          queuedFiles: 0,
          queueProgress: null,
          scanSummary: null,
          state: 'blocked',
        })
      )
    );
  });

  it('uses the typed missing-provider-key reason instead of parsing validation prose', async () => {
    validateApiKeyForSetMock.mockResolvedValueOnce({
      message: 'Provider credentials unavailable.',
      reason: 'missing-provider-key',
      valid: false,
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          blockedReason: 'missing-provider-key',
          lastError: 'Provider credentials unavailable.',
          state: 'blocked',
        })
      )
    );
    expect(ensureEmbeddingRuntimeStartedMock).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(enqueueBackfillMock).not.toHaveBeenCalled();
  });

  it('fails visibly when the shared embedding runtime cannot start', async () => {
    ensureEmbeddingRuntimeStartedMock.mockResolvedValueOnce({
      active: false,
      lastError: 'Embedding runtime boot failed.',
      runtimeId: 'embedding-host:test',
      runtimeKind: 'embedding-host',
      state: 'error',
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          lastError: 'Embedding runtime boot failed.',
          state: 'error',
        })
      )
    );
  });

  it('falls back to the default runtime error message when startup fails without details', async () => {
    ensureEmbeddingRuntimeStartedMock.mockResolvedValueOnce({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:test',
      runtimeKind: 'embedding-host',
      state: 'error',
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          lastError: 'Embedding runtime is unavailable.',
          state: 'error',
        })
      )
    );
  });

  // ─── Task 6: sequential per-root sync passes ───────────────────────────────

  it('calls service.sync once per root, in order, sequentially, when two handles are active', async () => {
    const root1 = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'workspace2',
      path: '/workspace/root2',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2];

    // Use a deferred to prove ordering: the second sync only starts after the first resolves.
    let resolveFirstSync!: () => void;
    const firstSyncDone = new Promise<void>((res) => {
      resolveFirstSync = res;
    });
    const callOrder: string[] = [];

    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockImplementation(async (req) => {
        const path = (req.rootDirectoryHandle as { path: string } | null)?.path ?? 'null';
        callOrder.push(`start:${path}`);
        if (path === root1.path) {
          await firstSyncDone;
        }
        callOrder.push(`end:${path}`);
      });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      // Wait until the first sync has started.
      await waitFor(() => expect(callOrder).toContain(`start:${root1.path}`));

      // The second sync must NOT have started yet (sequential, not parallel).
      expect(callOrder).not.toContain(`start:${root2.path}`);

      // Let root1 finish.
      resolveFirstSync();

      // Now root2 should complete.
      await waitFor(() => expect(callOrder).toContain(`end:${root2.path}`));

      expect(callOrder).toEqual([
        `start:${root1.path}`,
        `end:${root1.path}`,
        `start:${root2.path}`,
        `end:${root2.path}`,
      ]);
      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(syncSpy.mock.calls[0]?.[0]).toMatchObject({ rootDirectoryHandle: root1 });
      expect(syncSpy.mock.calls[1]?.[0]).toMatchObject({ rootDirectoryHandle: root2 });
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('defers collection-wide embedding backfill until the final root pass', async () => {
    const root1 = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'workspace2',
      path: '/workspace/root2',
      platform: 'electron',
    };
    const root3 = {
      kind: 'directory',
      name: 'workspace3',
      path: '/workspace/root3',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2, root3];

    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockResolvedValue(undefined);

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(3));

      expect(syncSpy.mock.calls.map((call) => call[0].backfillMode)).toEqual([
        'defer',
        'defer',
        'enqueue',
      ]);
      expect(
        syncSpy.mock.calls.map((call) => (call[0].rootDirectoryHandle as { path: string }).path)
      ).toEqual(['/workspace/root', '/workspace/root2', '/workspace/root3']);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('enqueues collection-wide embedding backfill on the final resolved root when a later root is unresolved', async () => {
    const root1 = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'workspace2',
      path: '/workspace/root2',
      platform: 'electron',
    };
    const root3 = {
      kind: 'directory',
      name: 'workspace3',
      path: '/workspace/root3',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2, root3];
    resolveDbRootIdMock.mockImplementation(async (rootPath: string) =>
      rootPath === root3.path ? null : `db:${rootPath}`
    );

    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockResolvedValue(undefined);

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));

      expect(
        syncSpy.mock.calls.map((call) => ({
          backfillMode: call[0].backfillMode,
          dbRootId: call[0].dbRootId,
          path: (call[0].rootDirectoryHandle as { path: string }).path,
        }))
      ).toEqual([
        { backfillMode: 'defer', dbRootId: 'db:/workspace/root', path: root1.path },
        { backfillMode: 'enqueue', dbRootId: 'db:/workspace/root2', path: root2.path },
      ]);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('stops the stale loop when a new triggerSync fires mid-loop', async () => {
    const root1 = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'workspace2',
      path: '/workspace/root2',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2];

    // firstSyncStarted lets the test gate when to fire the re-trigger.
    let firstSyncStarted!: () => void;
    const firstSyncStartedPromise = new Promise<void>((res) => {
      firstSyncStarted = res;
    });
    // neverResolve keeps root1 in-flight so we can confirm root2 from the OLD
    // loop is never called while the service is busy.
    const neverResolvePromise = new Promise<void>(() => {
      // intentionally never resolved — the service's own abort ends the in-flight pass
    });

    const syncCallHandles: string[] = [];
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockImplementation(async (req) => {
        const path = (req.rootDirectoryHandle as { path: string } | null)?.path ?? 'null';
        syncCallHandles.push(path);
        if (syncCallHandles.filter((p) => p === root1.path).length === 1) {
          // First call for root1: signal it started, then hang.
          firstSyncStarted();
          await neverResolvePromise;
        }
      });

    try {
      const { rerender } = render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      // Wait for the first loop's root1 pass to begin.
      await firstSyncStartedPromise;

      // Re-trigger by forcing a rerender (simulates a state change that re-fires the effect).
      fileSystemState.rootDirectoryHandles = [root1, root2];
      rerender(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      // Wait for the new loop to call root1 again.
      await waitFor(() => expect(syncCallHandles.filter((p) => p === root1.path).length).toBe(2));

      // Allow microtasks to flush so root2 from the new loop can be reached.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      // root2 from the OLD stale loop must never have been invoked.
      // Only root2 from the NEW loop may appear (after root1 resolves from the new loop).
      // Since root1 from the new loop also uses neverResolve (second call → resolves immediately),
      // we can assert root2 appears exactly once (from the new loop only).
      const root2Calls = syncCallHandles.filter((p) => p === root2.path);
      // The stale guard prevents the old loop from ever reaching root2,
      // so root2 can only appear from the new loop.
      // New loop's root1 resolves immediately (second call) → root2 follows.
      expect(root2Calls.length).toBeLessThanOrEqual(1);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('stops the active root loop when background work is paused mid-loop', async () => {
    const root1 = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'workspace2',
      path: '/workspace/root2',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2];

    let firstSyncStarted!: () => void;
    const firstSyncStartedPromise = new Promise<void>((resolve) => {
      firstSyncStarted = resolve;
    });
    let releaseFirstSync!: () => void;
    const firstSyncReleasePromise = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });

    const syncCallHandles: string[] = [];
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockImplementation(async (req) => {
        const path = (req.rootDirectoryHandle as { path: string } | null)?.path ?? 'null';
        syncCallHandles.push(path);
        if (path === root1.path) {
          firstSyncStarted();
          await firstSyncReleasePromise;
        }
      });
    try {
      const { unmount } = render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await firstSyncStartedPromise;
      const releasePause = await acquireBackgroundWorkPauseReason('local-llm');
      releaseFirstSync();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      expect(syncCallHandles).toEqual([root1.path]);
      releasePause();
      unmount();
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('stops the active root loop when background indexing is disabled mid-loop', async () => {
    const root1 = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'workspace2',
      path: '/workspace/root2',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2];

    let firstSyncStarted!: () => void;
    const firstSyncStartedPromise = new Promise<void>((resolve) => {
      firstSyncStarted = resolve;
    });
    let releaseFirstSync!: () => void;
    const firstSyncReleasePromise = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });

    const enabledSyncCallHandles: string[] = [];
    const disabledSyncCalls: string[] = [];
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockImplementation(async (req) => {
        const path = (req.rootDirectoryHandle as { path: string } | null)?.path ?? 'null';
        if (!req.enabled) {
          disabledSyncCalls.push(path);
          return;
        }
        enabledSyncCallHandles.push(path);
        if (path === root1.path) {
          firstSyncStarted();
          await firstSyncReleasePromise;
        }
      });
    const cancelSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'cancel')
      .mockResolvedValue(undefined);

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await firstSyncStartedPromise;

      act(() => {
        useBackgroundIndexingPreferencesStore.setState({ enabled: false });
      });

      await waitFor(() => expect(disabledSyncCalls.length).toBeGreaterThan(0));
      expect(cancelSpy).toHaveBeenCalled();
      releaseFirstSync();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      expect(enabledSyncCallHandles).toEqual([root1.path]);
    } finally {
      cancelSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });

  it('stops the active root loop when the provider unmounts mid-loop', async () => {
    const root1 = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'workspace2',
      path: '/workspace/root2',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2];

    let firstSyncStarted!: () => void;
    const firstSyncStartedPromise = new Promise<void>((resolve) => {
      firstSyncStarted = resolve;
    });
    let releaseFirstSync!: () => void;
    const firstSyncReleasePromise = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });

    const syncCallHandles: string[] = [];
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockImplementation(async (req) => {
        const path = (req.rootDirectoryHandle as { path: string } | null)?.path ?? 'null';
        syncCallHandles.push(path);
        if (path === root1.path) {
          firstSyncStarted();
          await firstSyncReleasePromise;
        }
      });

    try {
      const { unmount } = render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await firstSyncStartedPromise;
      unmount();
      releaseFirstSync();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      expect(syncCallHandles).toEqual([root1.path]);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('calls service.sync exactly once with the legacy single-handle request shape when only one handle is active', async () => {
    // fileSystemState already has one handle from beforeEach — confirm no change needed.
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockResolvedValue(undefined);

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));

      expect(syncSpy.mock.calls[0]?.[0]).toMatchObject({
        managedCollectionId: '00000000-0000-0000-0000-000000000101',
        rootDirectoryHandle: fileSystemState.rootDirectoryHandle,
      });
    } finally {
      syncSpy.mockRestore();
    }
  });

  // ─── Task 4 (phase 5): mid-session root registration ───────────────────────

  it('registers only the newly added root when rootDirectoryHandles grows mid-session', async () => {
    const { rerender } = render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    // The mount-time handle gets exactly one registration call (the hook
    // dedupes against the boot reconcile internally, so this is a no-op for
    // boot roots).
    await waitFor(() => expect(registerRootMock).toHaveBeenCalledTimes(1));
    expect(registerRootMock.mock.calls[0]?.[0]).toMatchObject({
      displayName: 'workspace',
      permissionState: 'granted',
      persisted: true,
      rootId: 'root-id-1',
    });

    // A new root arrives mid-session (Add Folder).
    const root2 = {
      kind: 'directory',
      name: 'second',
      path: '/workspace/second',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandles = [...fileSystemState.rootDirectoryHandles, root2];
    fileSystemState.rootIdByPath = new Map<string, string>([
      ['/workspace/root', 'root-id-1'],
      ['/workspace/second', 'root-id-2'],
    ]);
    rerender(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(registerRootMock).toHaveBeenCalledTimes(2));
    expect(registerRootMock.mock.calls[1]?.[0]).toMatchObject({
      displayName: 'second',
      permissionState: 'granted',
      persisted: true,
      rootId: 'root-id-2',
    });
    // The pre-existing root is NOT re-registered by the growth.
    const root1Calls = registerRootMock.mock.calls.filter(
      (call) => (call[0] as { rootId: string }).rootId === 'root-id-1'
    );
    expect(root1Calls).toHaveLength(1);
  });

  it('starts a sync pass for a newly ADDED root mid-session (indexer must not stay idle)', async () => {
    const root1 = fileSystemState.rootDirectoryHandle;
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockResolvedValue(undefined);

    try {
      const { rerender } = render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalled());
      const callsBeforeAdd = syncSpy.mock.calls.length;

      // Add Folder mid-session: the handles list grows and the id map learns
      // the new path. The sync loop MUST run a pass over the new root.
      const addedRoot = {
        kind: 'directory',
        name: 'added',
        path: '/workspace/added',
        platform: 'electron',
      };
      fileSystemState.rootDirectoryHandles = [...fileSystemState.rootDirectoryHandles, addedRoot];
      fileSystemState.rootIdByPath = new Map<string, string>([
        ['/workspace/root', 'root-id-1'],
        ['/workspace/added', 'root-id-2'],
      ]);
      rerender(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => {
        const syncedPaths = syncSpy.mock.calls
          .slice(callsBeforeAdd)
          .map((call) => (call[0].rootDirectoryHandle as { path?: string } | null)?.path);
        expect(syncedPaths).toContain('/workspace/added');
      });
      // The pre-existing root also resyncs (sequential whole-forest loop)
      // BEFORE the new root, so the new root's pass is not starved.
      const syncedPaths = syncSpy.mock.calls
        .slice(callsBeforeAdd)
        .map((call) => (call[0].rootDirectoryHandle as { path?: string } | null)?.path);
      expect(syncedPaths).toContain(root1?.path);
    } finally {
      syncSpy.mockRestore();
    }
  });

  function mockIndexedCoverage(countsByDbRootId: Record<string, number>): void {
    dbState.current = {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM file_records')) {
          return {
            rows: Object.entries(countsByDbRootId).map(([root_id, file_count]) => ({
              file_count: String(file_count),
              root_id,
            })),
          };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
  }

  it('syncs the least-indexed root first so a newly added root beats a fully-indexed one', async () => {
    const root1 = {
      kind: 'directory',
      name: 'root1',
      path: '/workspace/root-1',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'root2',
      path: '/workspace/root-2',
      platform: 'electron',
    };
    resolveDbRootIdMock.mockImplementation(async (rootPath: string) =>
      rootPath === root2.path ? 'db-root-2' : 'db-root-1'
    );
    // root1 is already indexed (100 files); root2 (newly added) has none.
    mockIndexedCoverage({ 'db-root-1': 100 });
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2];

    const callOrder: string[] = [];
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockImplementation(async (req) => {
        callOrder.push((req.rootDirectoryHandle as { path: string } | null)?.path ?? 'null');
      });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      // The 0-coverage root MUST sync before the fully-indexed one — otherwise a
      // folder you just added waits in line behind a giant in-progress import,
      // the real-world "added a folder, nothing happened" failure.
      await waitFor(() => expect(callOrder).toContain(root2.path));
      const root2Index = callOrder.indexOf(root2.path);
      const root1Index = callOrder.indexOf(root1.path);
      expect(root2Index).toBeGreaterThanOrEqual(0);
      expect(root2Index).toBeLessThan(root1Index === -1 ? Number.POSITIVE_INFINITY : root1Index);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('re-reads coverage each loop, so a root that imported nothing keeps first-claim priority', async () => {
    // Coverage is read fresh from file_records (not a session flag): a root whose
    // pass imported nothing — e.g. it was superseded mid-import — stays at 0 and
    // is still synced first on the next loop. It can never be wrongly deprioritized
    // under churn (the supersession-marking hazard raised in review).
    const root1 = {
      kind: 'directory',
      name: 'root1',
      path: '/workspace/root-1',
      platform: 'electron',
    };
    const root2 = {
      kind: 'directory',
      name: 'root2',
      path: '/workspace/root-2',
      platform: 'electron',
    };
    resolveDbRootIdMock.mockImplementation(async (rootPath: string) =>
      rootPath === root2.path ? 'db-root-2' : 'db-root-1'
    );
    // root2 stays at 0 coverage across loops (its sync is a no-op here).
    mockIndexedCoverage({ 'db-root-1': 100 });
    fileSystemState.rootDirectoryHandle = root1;
    fileSystemState.rootDirectoryHandles = [root1, root2];

    const callOrder: string[] = [];
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockImplementation(async (req) => {
        callOrder.push((req.rootDirectoryHandle as { path: string } | null)?.path ?? 'null');
      });

    try {
      const { rerender } = render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );
      await waitFor(() => expect(callOrder).toContain(root2.path));
      expect(callOrder.indexOf(root2.path)).toBeLessThan(
        callOrder.indexOf(root1.path) === -1
          ? Number.POSITIVE_INFINITY
          : callOrder.indexOf(root1.path)
      );

      // Re-trigger the loop. root2 still has 0 coverage → still synced first.
      callOrder.length = 0;
      fileSystemState.rootDirectoryHandles = [root1, root2];
      rerender(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );
      await waitFor(() => expect(callOrder).toContain(root2.path));
      const root2Index = callOrder.indexOf(root2.path);
      const root1Index = callOrder.indexOf(root1.path);
      expect(root2Index).toBeLessThan(root1Index === -1 ? Number.POSITIVE_INFINITY : root1Index);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('re-runs the sync when background work resumes after a pause (resume edge is wired without the dep)', async () => {
    const root = {
      kind: 'directory',
      name: 'root',
      path: '/workspace/root',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = root;
    fileSystemState.rootDirectoryHandles = [root];

    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockResolvedValue(undefined);
    let release: () => void = () => undefined;

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );
      await waitFor(() => expect(syncSpy).toHaveBeenCalled());

      // Pause: the arbiter emission must reach the provider even though
      // backgroundWorkSnapshot is no longer a triggerSync dependency.
      await act(async () => {
        release = await acquireBackgroundWorkPauseReason('local-llm');
      });
      await waitFor(() =>
        expect(useWorkspaceCollectionSyncStatusStore.getState().state).toBe('paused')
      );
      const callsWhilePaused = syncSpy.mock.calls.length;

      // Resume: the explicit arbiter subscription must re-trigger a sync pass.
      await act(async () => {
        release();
        release = () => undefined;
      });
      await waitFor(() => expect(syncSpy.mock.calls.length).toBeGreaterThan(callsWhilePaused));
    } finally {
      syncSpy.mockRestore();
      release();
    }
  });

  it('does not allow idle status when an active root is missing expected indexed files', async () => {
    const rootA = {
      kind: 'directory',
      name: 'root-a',
      path: '/workspace/root-a',
      platform: 'electron',
    };
    const rootB = {
      kind: 'directory',
      name: 'root-b',
      path: '/workspace/root-b',
      platform: 'electron',
    };
    fileSystemState.rootDirectoryHandle = rootA;
    fileSystemState.rootDirectoryHandles = [rootA, rootB];
    fileSystemState.rootIdByPath = new Map<string, string>([
      [rootA.path, 'adapter-root-a'],
      [rootB.path, 'adapter-root-b'],
    ]);
    resolveDbRootIdMock.mockImplementation(async (rootPath: string) => {
      if (rootPath === rootA.path) {
        return 'db-root-a';
      }
      if (rootPath === rootB.path) {
        return 'db-root-b';
      }
      return null;
    });
    readFullTreeWithOptionsMock.mockImplementation(async (_adapter, handle) => {
      const rootPath = (handle as { path: string }).path;
      return [
        {
          handle: { path: `${rootPath}/index.ts`, platform: 'electron' },
          name: 'index.ts',
          path: `${rootPath}/index.ts`,
          rootFolderId: rootPath,
          type: 'file',
        },
      ];
    });
    dbState.current = {
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('COUNT(*) AS file_count')) {
          return {
            rows: [{ file_count: '1', root_id: 'db-root-a' }],
          };
        }
        if (sql.includes('SELECT root_id, path')) {
          return {
            rows: [{ path: 'index.ts', root_id: 'db-root-a' }],
          };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
    const syncSpy = vi
      .spyOn(WorkspaceCollectionSyncService.prototype, 'sync')
      .mockResolvedValue(undefined);

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      syncSpy.mockClear();

      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          activeRootPath: rootB.path,
          currentFilePath: null,
          lastError: null,
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          managedCollectionName: 'Managed Cache',
          processedFiles: 2,
          queuedFiles: 0,
          state: 'idle',
        });
      });

      await waitFor(() => {
        expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
          activeRootPath: rootB.path,
          state: 'waiting',
        });
      });
      expect(useWorkspaceCollectionSyncStatusStore.getState().lastError).toContain(rootB.path);
      await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
      // Coverage-based ordering: root-b (0 indexed files) syncs before root-a
      // (1 indexed file) — least-covered first.
      expect(syncSpy.mock.calls.map(([request]) => request.rootDirectoryHandle?.path)).toEqual([
        rootB.path,
        rootA.path,
      ]);
      expect(syncSpy.mock.calls.every(([request]) => request.scope?.mode === 'full')).toBe(true);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('does not register handles that have no rootId mapping yet', async () => {
    fileSystemState.rootIdByPath = new Map<string, string>();

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() => expect(runEnhancedImportMock).toHaveBeenCalledTimes(1));
    expect(registerRootMock).not.toHaveBeenCalled();
  });

  it('exposes the workspace index debug API only while the provider is mounted', async () => {
    readFullTreeWithOptionsMock.mockImplementation(async (_adapter, _handle, options) => {
      options?.onEntrySkipped?.({
        entryType: 'directory',
        reason: 'default-ignore',
        relativePath: 'node_modules',
      });
      return [
        {
          handle: { path: '/workspace/root/src/index.ts', platform: 'electron' },
          name: 'index.ts',
          path: '/workspace/root/src/index.ts',
          rootFolderId: '/workspace/root',
          type: 'file',
        },
      ];
    });

    const rendered = render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    const debugApi = (
      window as unknown as {
        __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
          countExpected: () => Promise<unknown>;
        };
      }
    ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;
    expect(debugApi).toBeDefined();

    const counts = await debugApi?.countExpected();

    expect(counts).toEqual([
      expect.objectContaining({
        expectedFileCount: 1,
        includedFiles: ['src/index.ts'],
        policyPreset: 'balanced',
        rootPath: '/workspace/root',
        skippedByReason: expect.objectContaining({
          generatedOrIgnored: 1,
        }),
      }),
    ]);

    rendered.unmount();

    expect(
      (
        window as unknown as {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: unknown;
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__
    ).toBeUndefined();
  });

  it('exposes a stage benchmark hook that uses the background DB completion path', async () => {
    readFullTreeWithOptionsMock.mockResolvedValue([]);
    completeEmbeddingChunkBatchMock.mockResolvedValueOnce([{ id: 'job-0' }, { id: 'job-1' }]);

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    const debugApi = (
      window as unknown as {
        __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
          benchmarkStage: (request: {
            chunkCount: number;
            dimensions: number;
            mode: 'db-completion-ceiling';
          }) => Promise<{
            chunkCount: number;
            completedChunkCount: number;
            mode: string;
          }>;
        };
      }
    ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;

    const result = await debugApi?.benchmarkStage({
      chunkCount: 2,
      dimensions: 4,
      mode: 'db-completion-ceiling',
    });

    expect(completeEmbeddingChunkBatchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      chunkCount: 2,
      completedChunkCount: 2,
      mode: 'db-completion-ceiling',
    });
  });

  it('exposes a stage benchmark hook that uses the hidden chunking host bridge', async () => {
    readFullTreeWithOptionsMock.mockResolvedValue([]);
    const chunkBatchMock = vi.fn(async () => [
      {
        chunks: [{ content: 'chunk' }],
        skipped: false,
      },
    ]);
    Object.defineProperty(window, 'chunkingHost', {
      configurable: true,
      value: {
        chunkBatch: chunkBatchMock,
      },
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    const debugApi = (
      window as unknown as {
        __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
          benchmarkStage: (request: { chunkCount: number; mode: 'chunking-ceiling' }) => Promise<{
            chunkCount: number;
            completedChunkCount: number;
            mode: string;
          }>;
        };
      }
    ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;

    const result = await debugApi?.benchmarkStage({
      chunkCount: 1,
      mode: 'chunking-ceiling',
    });

    expect(chunkBatchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      chunkCount: 1,
      completedChunkCount: 1,
      mode: 'chunking-ceiling',
    });
  });

  it('exposes a stage benchmark hook that uses the hidden embedding host bridge', async () => {
    readFullTreeWithOptionsMock.mockResolvedValue([]);
    const queryEmbeddingMock = vi.fn(async () => [0.1, 0.2, 0.3, 0.4]);
    const getStatusMock = vi.fn(async () => ({
      embeddingRuntime: {
        actualWorkerMetadata: {
          device: 'webgpu',
          dtype: 'fp32',
          fallbackApplied: false,
        },
        backendMismatch: false,
        selectedDevicePreference: 'webgpu',
      },
    }));
    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: {
        getStatus: getStatusMock,
        queryEmbedding: queryEmbeddingMock,
      },
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    const debugApi = (
      window as unknown as {
        __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
          benchmarkStage: (request: {
            chunkCount: number;
            dimensions: number;
            mode: 'embedding-ceiling';
          }) => Promise<{
            chunkCount: number;
            completedChunkCount: number;
            mode: string;
          }>;
        };
      }
    ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;

    const result = await debugApi?.benchmarkStage({
      chunkCount: 1,
      dimensions: 4,
      mode: 'embedding-ceiling',
    });

    expect(queryEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      chunkCount: 1,
      completedChunkCount: 1,
      mode: 'embedding-ceiling',
    });
  });

  it('includes chunked records and chunk stats grouped by root and embedding set in debug snapshots', async () => {
    readFullTreeWithOptionsMock.mockResolvedValue([]);
    const queryMock = vi.fn(async (sql: string, _params?: unknown[], _options?: unknown) => {
      if (sql.includes('FROM roots')) {
        return { rows: [] };
      }
      if (sql.includes('chunked_records_by_root_query_marker')) {
        return {
          rows: [
            {
              chunk_count: 2,
              chunks_processed_at: '2026-06-17T00:00:00.000Z',
              id: 'file-record-1',
              relative_path: 'src/index.ts',
              root_id: 'root-id-1',
            },
          ],
        };
      }
      if (sql.includes('chunks_by_root_and_set_query_marker')) {
        return {
          rows: [
            {
              chunk_count: 2,
              embedded_chunk_count: 1,
              embedding_set_id: 'workspace-index-set',
              pending_chunk_count: 1,
              root_id: 'root-id-1',
            },
          ],
        };
      }
      return { rows: [] };
    });
    Object.assign(window, {
      electronAPI: {
        db: {
          query: queryMock,
        },
      },
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      const debugApi = (
        window as unknown as {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
            snapshot: () => Promise<{
              chunkStatsByRootAndSet?: unknown[];
              chunkedRecordsByRoot?: unknown[];
            }>;
          };
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;

      const snapshot = await debugApi?.snapshot();

      expect(snapshot?.chunkedRecordsByRoot).toEqual([
        expect.objectContaining({
          id: 'file-record-1',
          relative_path: 'src/index.ts',
          root_id: 'root-id-1',
        }),
      ]);
      const chunkedRecordsQuery = queryMock.mock.calls.find(([sql]) =>
        sql.includes('chunked_records_by_root_query_marker')
      )?.[0];
      expect(chunkedRecordsQuery).toContain('fr.path AS relative_path');
      expect(chunkedRecordsQuery).not.toContain('fr.relative_path');
      expect(snapshot?.chunkStatsByRootAndSet).toEqual([
        expect.objectContaining({
          embedding_set_id: 'workspace-index-set',
          root_id: 'root-id-1',
        }),
      ]);
    } finally {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });

  it('includes failed job details and queue readiness in debug snapshots', async () => {
    readFullTreeWithOptionsMock.mockResolvedValue([]);
    const queryMock = vi.fn(async (sql: string, _params?: unknown[], _options?: unknown) => {
      if (sql.includes('job_queue_readiness_query_marker')) {
        return {
          rows: [
            {
              due_count: 3,
              future_count: 2,
              newest_run_at: '2026-06-18T01:40:00.000Z',
              oldest_run_at: '2026-06-18T01:36:00.000Z',
              state: 'queued',
            },
          ],
        };
      }
      if (sql.includes('recent_embedding_failures_query_marker')) {
        return {
          rows: [
            {
              attempts: 3,
              error: 'Embedding dimension mismatch',
              id: 'job-failed-1',
              max_attempts: 3,
              payload: { chunkId: 'chunk-1' },
              run_at: '2026-06-18T01:39:00.000Z',
              state: 'failed',
              updated_at: '2026-06-18T01:39:01.000Z',
              worker_id: 'embed-worker-test',
            },
          ],
        };
      }
      return { rows: [] };
    });
    Object.assign(window, {
      electronAPI: {
        db: {
          query: queryMock,
        },
      },
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      const debugApi = (
        window as unknown as {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
            snapshot: () => Promise<{
              jobQueueReadiness?: unknown[];
              recentEmbeddingFailures?: unknown[];
            }>;
          };
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;

      const snapshot = await debugApi?.snapshot();

      expect(
        queryMock.mock.calls.every(([, , options]) => {
          const priority = (options as { priority?: unknown } | undefined)?.priority;
          return priority === 'background';
        })
      ).toBe(true);
      expect(snapshot?.jobQueueReadiness).toEqual([
        expect.objectContaining({
          due_count: 3,
          future_count: 2,
          state: 'queued',
        }),
      ]);
      expect(snapshot?.recentEmbeddingFailures).toEqual([
        expect.objectContaining({
          error: 'Embedding dimension mismatch',
          id: 'job-failed-1',
          payload: { chunkId: 'chunk-1' },
        }),
      ]);
    } finally {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });

  it('exposes a lightweight debug summary without full file lists', async () => {
    readFullTreeWithOptionsMock.mockImplementation(async () => {
      throw new Error('summary must not read the full file tree');
    });
    const queryMock = vi.fn(async (sql: string, _params?: unknown[], _options?: unknown) => {
      if (sql.includes('workspace_index_summary_roots_marker')) {
        return {
          rows: [{ id: 'root-id-1', path: '/workspace/root', status: 'active' }],
        };
      }
      if (sql.includes('workspace_index_summary_file_records_marker')) {
        return {
          rows: [
            {
              chunked_file_count: 10,
              file_count: 10,
              root_id: 'root-id-1',
              unchunked_file_count: 0,
            },
          ],
        };
      }
      if (sql.includes('workspace_index_summary_chunks_marker')) {
        return {
          rows: [
            {
              chunk_count: 42,
              embedded_chunk_count: 40,
              embedding_set_id: 'workspace-index-set',
              pending_chunk_count: 2,
              root_id: 'root-id-1',
            },
          ],
        };
      }
      if (sql.includes('workspace_index_summary_job_queue_marker')) {
        return {
          rows: [
            {
              count: 2,
              job_type: 'embed_chunk',
              queue: 'embeddings',
              state: 'queued',
            },
          ],
        };
      }
      return { rows: [] };
    });
    Object.assign(window, {
      electronAPI: {
        db: {
          query: queryMock,
        },
      },
    });

    try {
      render(
        <WorkspaceCollectionSyncProvider>
          <div data-testid="child" />
        </WorkspaceCollectionSyncProvider>
      );

      const debugApi = (
        window as unknown as {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
            summary: () => Promise<{
              chunkStatsByRootAndSet?: unknown[];
              fileRecordsByRoot?: unknown[];
              jobQueue?: unknown[];
              roots?: unknown[];
            }>;
          };
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;

      const summary = await debugApi?.summary();

      expect(summary?.roots).toEqual([expect.objectContaining({ id: 'root-id-1' })]);
      expect(summary?.fileRecordsByRoot).toEqual([
        expect.objectContaining({ file_count: 10, root_id: 'root-id-1' }),
      ]);
      expect(summary?.chunkStatsByRootAndSet).toEqual([
        expect.objectContaining({
          chunk_count: 42,
          embedded_chunk_count: 40,
          root_id: 'root-id-1',
        }),
      ]);
      expect(summary?.jobQueue).toEqual([expect.objectContaining({ count: 2, state: 'queued' })]);
      expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
      expect(
        queryMock.mock.calls.some(([sql]) => sql.includes('chunked_records_by_root_query_marker'))
      ).toBe(false);
      expect(
        queryMock.mock.calls.every(([, , options]) => {
          const priority = (options as { priority?: unknown } | undefined)?.priority;
          return priority === 'background';
        })
      ).toBe(true);
    } finally {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });

  it('exposes the workspace index debug API in desktop E2E mode without renderer process env', () => {
    vi.stubEnv('NODE_ENV', 'production');
    (
      window as typeof window & {
        desktopLifecycle?: { isTestMode: boolean };
      }
    ).desktopLifecycle = { isTestMode: true };

    const rendered = render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    expect(
      (
        window as unknown as {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: unknown;
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__
    ).toBeDefined();

    rendered.unmount();
    Reflect.deleteProperty(window, 'desktopLifecycle');
    vi.unstubAllEnvs();
  });

  it('exposes the workspace index debug API in web Playwright E2E mode', () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'webdriver');
    vi.stubEnv('NODE_ENV', 'production');
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: true,
    });

    try {
      expect(shouldExposeWorkspaceIndexDebugApi({ MODE: 'production' })).toBe(true);
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(window.navigator, 'webdriver', previousDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, 'webdriver');
      }
      vi.unstubAllEnvs();
    }
  });

  it('does not expose the workspace index debug API in ordinary production web mode', () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'webdriver');
    vi.stubEnv('NODE_ENV', 'production');
    Reflect.deleteProperty(window, 'desktopLifecycle');
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: false,
    });

    try {
      expect(shouldExposeWorkspaceIndexDebugApi({ MODE: 'production' })).toBe(false);
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(window.navigator, 'webdriver', previousDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, 'webdriver');
      }
      vi.unstubAllEnvs();
    }
  });
});

describe('boundBackgroundPermitWait', () => {
  it('resolves immediately when the underlying permit grants without delay', async () => {
    const basePermit = vi.fn(
      async (_options: { readonly label: string; readonly signal?: AbortSignal }) => undefined
    );
    const wrapped = boundBackgroundPermitWait(basePermit);

    await expect(wrapped({ label: 'test' })).resolves.toBeUndefined();
    expect(basePermit).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'test', signal: expect.any(AbortSignal) })
    );
    // Granted permit must NOT have been aborted.
    const passedSignal = basePermit.mock.calls[0]?.[0]?.signal;
    expect(passedSignal?.aborted).toBe(false);
  });

  it('proceeds (resolves) after the max wait when the underlying permit blocks indefinitely', async () => {
    vi.useFakeTimers();
    try {
      // A permit that never grants on its own — it only settles when aborted,
      // mirroring the real controller polling under sustained foreground pressure.
      const basePermit = vi.fn(
        (options: { readonly label: string; readonly signal?: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new Error('Background database permit aborted'));
            });
          })
      );
      const wrapped = boundBackgroundPermitWait(basePermit);

      const permitPromise = wrapped({ label: 'Workspace Index import' });
      // Before the bound elapses, the wrapper is still waiting.
      let settled = false;
      void permitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);

      // Once the max wait elapses, the wrapper aborts the underlying permit and
      // proceeds so background work can't be starved indefinitely.
      await vi.advanceTimersByTimeAsync(2);
      await expect(permitPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows a non-timeout rejection from the underlying permit', async () => {
    const basePermit = vi.fn(async () => {
      throw new Error('scheduler exploded');
    });
    const wrapped = boundBackgroundPermitWait(basePermit);

    await expect(wrapped({ label: 'test' })).rejects.toThrow('scheduler exploded');
  });
});
