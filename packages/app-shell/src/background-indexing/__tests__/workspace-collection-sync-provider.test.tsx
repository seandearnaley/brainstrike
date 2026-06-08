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
import type {
  WorkspaceIndexingQosInputs,
  WorkspaceIndexingQosPolicy,
} from '@brainstrike/utils/workspace-indexing-qos';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceCollectionSyncProvider } from '../workspace-collection-sync-provider';
import { WorkspaceCollectionSyncService } from '../workspace-collection-sync-service';

const {
  runEnhancedImportMock,
  readFullTreeWithOptionsMock,
  processFilesMock,
  listManagedCacheEntryMetadataMock,
  applyManagedCacheBatchLocalMock,
  updateMock,
  deleteByFileRecordIdMock,
  getByIdMock,
  getOrCreateWorkspaceIndexSetMock,
  createPriorityDbHandleMock,
  validateApiKeyForSetMock,
  ensureChunkingWorkerMock,
  ensureEmbeddingRuntimeStartedMock,
  enqueueBackfillMock,
  cancelBackfillMock,
  dbState,
  vectorQueueServiceState,
  fileSystemState,
  fileTreeContextState,
  idleSchedulerSnapshot,
  resolveWorkspaceIndexingQosPolicyMock,
} = vi.hoisted(() => ({
  runEnhancedImportMock: vi.fn(),
  readFullTreeWithOptionsMock: vi.fn(),
  processFilesMock: vi.fn(),
  listManagedCacheEntryMetadataMock: vi.fn(),
  applyManagedCacheBatchLocalMock: vi.fn(
    async (db: {
      transaction?: (
        fn: (tx: { query: ReturnType<typeof vi.fn> }) => Promise<void>
      ) => Promise<void>;
    }) => {
      await db.transaction?.(async () => undefined);
    }
  ),
  updateMock: vi.fn(),
  deleteByFileRecordIdMock: vi.fn(),
  getByIdMock: vi.fn(),
  getOrCreateWorkspaceIndexSetMock: vi.fn(),
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
  validateApiKeyForSetMock: vi.fn(),
  ensureChunkingWorkerMock: vi.fn(),
  ensureEmbeddingRuntimeStartedMock: vi.fn(),
  enqueueBackfillMock: vi.fn(async () => ({ requestId: 'background-indexing-backfill:test' })),
  cancelBackfillMock: vi.fn(async () => {}),
  resolveWorkspaceIndexingQosPolicyMock: vi.fn(),
  dbState: {
    current: {
      query: vi.fn(async () => ({ rows: [] })),
      exec: vi.fn(async () => undefined),
      transaction: vi.fn(async (fn: (tx: { query: ReturnType<typeof vi.fn> }) => unknown) =>
        fn({ query: vi.fn(async () => ({ rows: [] })) })
      ),
    } as {
      exec: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      transaction: ReturnType<typeof vi.fn>;
    } | null,
  },
  vectorQueueServiceState: {
    current: {
      validateApiKeyForSet: vi.fn(),
    } as {
      validateApiKeyForSet: ReturnType<typeof vi.fn>;
    } | null,
  },
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
    } | null,
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
    },
    queued: {
      foreground: 0,
      normal: 0,
      background: 0,
    },
    runningLabel: null,
    runningPriority: null,
    snapshotAt: 1000,
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
  WORKSPACE_INDEX_SYSTEM_ROLE: 'workspace-index',
  JobQueue: vi.fn(function MockJobQueue() {
    return {
      enqueueBatch: vi.fn(),
      clear: vi.fn(),
      getQueueStats: vi.fn(async () => []),
      requeueFailed: vi.fn(),
    };
  }),
  applyManagedCacheBatch: applyManagedCacheBatchLocalMock,
  createDatabasePressureController: vi.fn(() => ({
    waitForBackgroundPermit: vi.fn(async () => undefined),
  })),
  createPriorityDbHandle: createPriorityDbHandleMock,
  getDatabasePressureWaitingReason: vi.fn(() => null),
  getDatabaseWorkScheduler: vi.fn(() => ({
    getSnapshot: vi.fn(() => idleSchedulerSnapshot),
    run: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  })),
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
  usePGliteDatabase: () => dbState.current,
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: { readDirectory: vi.fn(), readFile: vi.fn() },
  }),
  createFileContentProcessor: () => ({
    processFiles: processFilesMock,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    isAccessLoading: fileSystemState.isAccessLoading,
    rootDirectoryHandle: fileSystemState.rootDirectoryHandle,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/tree', () => ({
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
      cancelBackfill: cancelBackfillMock,
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
    fileTreeContextState.current = {
      isLoading: false,
      isRestorationSettled: true,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
    };
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetBackgroundWorkArbiterForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
    dbState.current = {
      query: vi.fn(async () => ({ rows: [] })),
      exec: vi.fn(async () => undefined),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    };
    vectorQueueServiceState.current = {
      validateApiKeyForSet: validateApiKeyForSetMock,
    };

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
      systemRole: 'workspace-index',
    };

    getByIdMock.mockResolvedValue(collection);
    getOrCreateWorkspaceIndexSetMock.mockResolvedValue(collection);
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

  it('creates and syncs the default workspace index when fresh preferences have no managed collection', async () => {
    const workspaceIndex: EmbeddingSet = {
      id: '00000000-0000-0000-0000-000000000202',
      name: 'Workspace Index',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      dimensions: 1536,
      distance: 'cosine',
      createdAt: new Date().toISOString(),
      systemRole: 'workspace-index',
    };
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      hasHydrated: true,
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

  it('dedupes workspace index bootstrap while collection creation is in flight', async () => {
    const workspaceIndex: EmbeddingSet = {
      id: '00000000-0000-0000-0000-000000000202',
      name: 'Workspace Index',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      distance: 'cosine',
      createdAt: new Date().toISOString(),
      systemRole: 'workspace-index',
    };
    let resolveBootstrap: (collection: EmbeddingSet) => void;
    const bootstrapPromise = new Promise<EmbeddingSet>((resolve) => {
      resolveBootstrap = resolve;
    });
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      hasHydrated: true,
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
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      hasHydrated: true,
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
          state: 'paused',
          managedCollectionId: '00000000-0000-0000-0000-000000000101',
          pauseReasons: ['Paused manually'],
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
            state: 'error',
            lastError: 'Synthetic sync failure',
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
            state: 'error',
            activeRootPath: null,
            lastError: 'Synthetic string sync failure',
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
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      hasHydrated: true,
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
            state: 'error',
            lastError: 'Synthetic disabled sync failure',
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

  it('pauses background indexing when the shared background-work arbiter is paused', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      mode: 'root-folder-cache',
      hasHydrated: true,
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
          state: 'paused',
          pauseReasons: ['Paused manually'],
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
            state: 'paused',
            pauseReasons: ['Paused for local assistant'],
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
      indexingPolicyPreset: 'balanced',
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      mode: 'root-folder-cache',
      hasHydrated: true,
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
            state: 'paused',
            pauseReasons: ['Paused manually', 'Paused for local assistant'],
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
      indexingPolicyPreset: 'balanced',
      managedCollectionId: '00000000-0000-0000-0000-000000000101',
      mode: 'root-folder-cache',
      hasHydrated: true,
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
        name: 'index.ts',
        path: '/workspace/root/src/index.ts',
        type: 'file',
        handle: { platform: 'electron', path: '/workspace/root/src/index.ts' },
        rootFolderId: '/workspace/root',
      },
    ]);

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(ensureEmbeddingRuntimeStartedMock).not.toHaveBeenCalled();
  });

  it('reports an error when the shared runtime dependencies are unavailable while enabled', async () => {
    dbState.current = null;

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          state: 'error',
          lastError: 'Background indexing runtime is unavailable.',
        })
      )
    );
  });

  it('resets status when the runtime is unavailable but background indexing is disabled', async () => {
    dbState.current = null;
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
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          state: 'disabled',
          lastError: null,
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
            state: 'error',
            lastError: 'Synthetic cancel failure',
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
          state: 'error',
          lastError: 'Vector queue service is unavailable.',
        })
      )
    );
  });

  it('blocks workspace indexing when provider validation reports a missing key', async () => {
    const missingKeyMessage =
      'OpenAI API key not configured. Please add your API key (OPENAI_API_KEY) in Settings → Secrets or set the environment variable.';
    validateApiKeyForSetMock.mockResolvedValueOnce({
      valid: false,
      reason: 'missing-provider-key',
      message: missingKeyMessage,
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          state: 'blocked',
          blockedReason: 'missing-provider-key',
          lastError: missingKeyMessage,
        })
      )
    );
    expect(ensureEmbeddingRuntimeStartedMock).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(enqueueBackfillMock).not.toHaveBeenCalled();
  });

  it('uses the typed missing-provider-key reason instead of parsing validation prose', async () => {
    validateApiKeyForSetMock.mockResolvedValueOnce({
      valid: false,
      reason: 'missing-provider-key',
      message: 'Provider credentials unavailable.',
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          state: 'blocked',
          blockedReason: 'missing-provider-key',
          lastError: 'Provider credentials unavailable.',
        })
      )
    );
    expect(ensureEmbeddingRuntimeStartedMock).not.toHaveBeenCalled();
    expect(runEnhancedImportMock).not.toHaveBeenCalled();
    expect(enqueueBackfillMock).not.toHaveBeenCalled();
  });

  it('fails visibly when the shared embedding runtime cannot start', async () => {
    ensureEmbeddingRuntimeStartedMock.mockResolvedValueOnce({
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host:test',
      state: 'error',
      active: false,
      lastError: 'Embedding runtime boot failed.',
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          state: 'error',
          lastError: 'Embedding runtime boot failed.',
        })
      )
    );
  });

  it('falls back to the default runtime error message when startup fails without details', async () => {
    ensureEmbeddingRuntimeStartedMock.mockResolvedValueOnce({
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host:test',
      state: 'error',
      active: false,
      lastError: null,
    });

    render(
      <WorkspaceCollectionSyncProvider>
        <div data-testid="child" />
      </WorkspaceCollectionSyncProvider>
    );

    await waitFor(() =>
      expect(useWorkspaceCollectionSyncStatusStore.getState()).toEqual(
        expect.objectContaining({
          state: 'error',
          lastError: 'Embedding runtime is unavailable.',
        })
      )
    );
  });
});
