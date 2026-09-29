import type { BrowserWindow } from 'electron';
import { vi } from 'vitest';
export function createWindowWithWebContents(sender: {
  id?: number;
  isDestroyed?: () => boolean;
  send: (...args: unknown[]) => unknown;
}): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      ...sender,
      isDestroyed: sender.isDestroyed ?? (() => false),
    },
  } as unknown as BrowserWindow;
}

// Hoist Electron and db mocks safely
const {
  handlers,
  mockDb,
  browserWindowMock,
  applyManagedCacheBatchMock,
  invalidateManagedCacheEntriesByIdentityMock,
  parseManagedCacheBatchArgsMock,
  parseManagedCacheInvalidationsArgsMock,
  getDatabaseMock,
  loggerWarn,
  loggerDebug,
  isCorruptionErrorMock,
  handleRuntimeCorruptionMock,
  resetLocalDatabaseMock,
  closeDatabaseMock,
  resetDesktopApplicationDataMock,
  getDatabaseDiagnosticsMock,
  getDbHostManagerMock,
  enqueueEmbeddingBackfillMock,
  embeddingHostIsHostWindowMock,
  embeddingHostEnsureStartedMock,
  embeddingHostGetStatusMock,
  embeddingHostResetMock,
  embeddingHostStopMock,
  embeddingHostDestroyAndRestartMock,
  storageClearMock,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockDb = {
    exec: vi.fn(),
    live: {
      incrementalQuery: vi.fn(),
      query: vi.fn(),
    },
    query: vi.fn(),
    transaction: vi.fn(),
  };
  const browserWindowMock = Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
  });
  const applyManagedCacheBatchMock = vi.fn(async () => undefined);
  const invalidateManagedCacheEntriesByIdentityMock = vi.fn(async () => ({
    canceledEmbeddingJobCount: 0,
    deletedChunkIds: [],
    deletedFileRecordIds: [],
  }));
  const parseManagedCacheBatchArgsMock = vi.fn((payload: unknown) => {
    if (
      !(
        payload &&
        typeof payload === 'object' &&
        'embeddingSetId' in payload &&
        'changes' in payload
      )
    ) {
      throw new Error('Invalid managed cache batch payload.');
    }
    const candidate = payload as { changes?: unknown; embeddingSetId?: unknown };
    if (
      typeof candidate.embeddingSetId !== 'string' ||
      candidate.embeddingSetId.length === 0 ||
      !Array.isArray(candidate.changes)
    ) {
      throw new Error('Invalid managed cache batch payload.');
    }
    return payload;
  });
  const parseManagedCacheInvalidationsArgsMock = vi.fn((payload: unknown) => {
    if (
      !(
        payload &&
        typeof payload === 'object' &&
        'embeddingSetId' in payload &&
        'targets' in payload
      )
    ) {
      throw new Error('Invalid managed cache invalidation payload.');
    }
    const candidate = payload as { embeddingSetId?: unknown; targets?: unknown };
    if (
      typeof candidate.embeddingSetId !== 'string' ||
      candidate.embeddingSetId.length === 0 ||
      !Array.isArray(candidate.targets)
    ) {
      throw new Error('Invalid managed cache invalidation payload.');
    }
    return payload;
  });
  const getDatabaseMock = vi.fn(() => mockDb);
  const loggerWarn = vi.fn();
  const loggerDebug = vi.fn();
  // Matches the isCorruptionError(error) signature of database-corruption-classifier
  // so tests can install error-discriminating implementations.
  const isCorruptionErrorMock = vi.fn((_error: unknown) => false);
  const handleRuntimeCorruptionMock = vi.fn();
  const resetLocalDatabaseMock = vi.fn();
  const storageClearMock = vi.fn(async () => undefined);
  const closeDatabaseMock = vi.fn();
  const resetDesktopApplicationDataMock = vi.fn(async () => ({
    deletedPaths: [],
    pendingDeletionPaths: [],
    preservedPaths: [],
  }));
  const enqueueEmbeddingBackfillMock = vi.fn();
  const embeddingHostIsHostWindowMock = vi.fn(() => false);
  const embeddingHostEnsureStartedMock = vi.fn(async () => ({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'running' as const,
  }));
  const embeddingHostGetStatusMock = vi.fn(() => ({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'running' as const,
  }));
  const embeddingHostResetMock = vi.fn(async () => ({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'running' as const,
  }));
  const embeddingHostStopMock = vi.fn(async () => ({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'stopped' as const,
  }));
  const embeddingHostDestroyAndRestartMock = vi.fn(async () => ({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'running' as const,
  }));
  const getDatabaseDiagnosticsMock = vi.fn(() => ({
    appDataDir: '/mock/documents/BrainStrike-dev/profiles/test',
    databaseLockHeld: true,
    databaseLockPath: '/mock/documents/BrainStrike-dev/profiles/test/.db-process.lock',
    databaseProfile: 'test',
    dataDir: '/mock/documents/BrainStrike-dev/profiles/test/pgdata',
    hasDatabaseHandle: true,
    initializationAttemptCount: 1,
    initializationInFlight: false,
    lastInitializationFailure: null,
    lastInitializationStartedAt: '2026-02-15T00:00:00.000Z',
    lastInitializationSucceededAt: '2026-02-15T00:00:01.000Z',
    lastRuntimeCorruptionAt: null,
    lastRuntimeCorruptionContext: null,
    nodeEnv: 'test',
    runtimeCorruptionRecoveryCount: 0,
  }));
  const getDbHostManagerMock = vi.fn(() => ({
    applyManagedCacheBatch: applyManagedCacheBatchMock,
    getDiagnostics: getDatabaseDiagnosticsMock,
    invalidateManagedCacheEntriesByIdentity: invalidateManagedCacheEntriesByIdentityMock,
  }));
  return {
    applyManagedCacheBatchMock,
    browserWindowMock,
    closeDatabaseMock,
    embeddingHostDestroyAndRestartMock,
    embeddingHostEnsureStartedMock,
    embeddingHostGetStatusMock,
    embeddingHostIsHostWindowMock,
    embeddingHostResetMock,
    embeddingHostStopMock,
    enqueueEmbeddingBackfillMock,
    getDatabaseDiagnosticsMock,
    getDatabaseMock,
    getDbHostManagerMock,
    handleRuntimeCorruptionMock,
    handlers,
    invalidateManagedCacheEntriesByIdentityMock,
    isCorruptionErrorMock,
    loggerDebug,
    loggerWarn,
    mockDb,
    parseManagedCacheBatchArgsMock,
    parseManagedCacheInvalidationsArgsMock,
    resetDesktopApplicationDataMock,
    resetLocalDatabaseMock,
    storageClearMock,
  };
});

export {
  applyManagedCacheBatchMock,
  browserWindowMock,
  closeDatabaseMock,
  embeddingHostDestroyAndRestartMock,
  embeddingHostEnsureStartedMock,
  embeddingHostGetStatusMock,
  embeddingHostIsHostWindowMock,
  embeddingHostResetMock,
  embeddingHostStopMock,
  enqueueEmbeddingBackfillMock,
  getDatabaseDiagnosticsMock,
  getDatabaseMock,
  getDbHostManagerMock,
  handleRuntimeCorruptionMock,
  handlers,
  invalidateManagedCacheEntriesByIdentityMock,
  isCorruptionErrorMock,
  loggerDebug,
  loggerWarn,
  mockDb,
  parseManagedCacheBatchArgsMock,
  parseManagedCacheInvalidationsArgsMock,
  resetDesktopApplicationDataMock,
  resetLocalDatabaseMock,
  storageClearMock,
};

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    applyManagedCacheBatch: applyManagedCacheBatchMock,
    invalidateManagedCacheEntriesByIdentity: invalidateManagedCacheEntriesByIdentityMock,
    parseManagedCacheBatchArgs: parseManagedCacheBatchArgsMock,
    recoverInterruptedDimensionIndexMaintenanceAtStartup: vi.fn(async () => 0),
  };
});
vi.mock('@brainstrike/db/react', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/db/react')>('@brainstrike/db/react');
  return {
    ...actual,
    applyManagedCacheBatch: applyManagedCacheBatchMock,
    invalidateManagedCacheEntriesByIdentity: invalidateManagedCacheEntriesByIdentityMock,
    parseManagedCacheBatchArgs: parseManagedCacheBatchArgsMock,
  };
});

vi.mock('../../db-shared', async () => {
  const actual = await vi.importActual<typeof import('../../db-shared')>('../../db-shared');
  return {
    ...actual,
    parseManagedCacheInvalidationsArgs: parseManagedCacheInvalidationsArgsMock,
  };
});

vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const typedIpcMain = electronUtils.createIpcMainMock();
  Object.assign(typedIpcMain, {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  });
  // Track handlers for direct invocation
  typedIpcMain.handle.mockImplementation(
    (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    }
  );
  const app = electronUtils.createAppMock({
    documentsPath: '/mock/documents',
    whenReadyResolved: true,
  });
  const mockBrowserWindowInstance = {
    destroy: vi.fn(),
    getBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
    getNormalBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    maximize: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    show: vi.fn(),
    webContents: {
      on: vi.fn(),
      openDevTools: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
  browserWindowMock.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, mockBrowserWindowInstance);
  });
  return {
    app,
    BrowserWindow: browserWindowMock,
    clipboard: {
      writeText: vi.fn(),
    },
    ipcMain: typedIpcMain,
    Menu: {
      buildFromTemplate: vi.fn(),
      setApplicationMenu: vi.fn(),
    },
    powerMonitor: {
      on: vi.fn(),
    },
    powerSaveBlocker: {
      isStarted: vi.fn(() => true),
      start: vi.fn(() => 1),
      stop: vi.fn(),
    },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
    screen: {
      getAllDisplays: vi.fn(() => []),
      getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { height: 1080, width: 1920 } })),
    },
    session: {
      defaultSession: {
        on: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onHeadersReceived: vi.fn() },
      },
    },
    shell: {
      openPath: vi.fn().mockResolvedValue(''),
      showItemInFolder: vi.fn(),
    },
  };
});

vi.mock('../../db-main', () => ({
  closeDatabase: closeDatabaseMock,
  getDatabase: getDatabaseMock,
  getDatabaseDiagnostics: getDatabaseDiagnosticsMock,
  handleRuntimeCorruption: handleRuntimeCorruptionMock,
  resetLocalDatabase: resetLocalDatabaseMock,
}));

// Forces the corruption branch per test; classification itself is covered by
// database-corruption-classifier.test.ts.
vi.mock('../../database-corruption-classifier', () => ({
  isCorruptionError: isCorruptionErrorMock,
}));

vi.mock('../../db-host-manager', () => ({
  getDbHostManager: getDbHostManagerMock,
}));

vi.mock('../../dimension-index-maintenance-capabilities', () => ({
  probeDimensionIndexRuntimeCapabilities: vi.fn(async () => ({
    hnswIndexBuild: {
      error: null,
      supported: true,
    },
    maintenanceSettings: {
      initialMemoryBytes: null,
      maintenanceWorkMem: null,
      maxParallelMaintenanceWorkers: null,
    },
    progressReporting: {
      error: null,
      supported: false,
    },
  })),
}));

vi.mock('../../desktop-factory-reset', () => ({
  resetDesktopApplicationData: resetDesktopApplicationDataMock,
}));

vi.mock('../../embedding-backfill', () => ({
  enqueueEmbeddingBackfill: enqueueEmbeddingBackfillMock,
}));

vi.mock('../../embedding-host-manager', () => ({
  EmbeddingHostManager: class MockEmbeddingHostManager {
    acceptStatusReport = vi.fn();
    dispose = vi.fn(async () => {});
    ensureStarted = embeddingHostEnsureStartedMock;
    getStatus = embeddingHostGetStatusMock;
    isHostWindow = embeddingHostIsHostWindowMock;
    reset = embeddingHostResetMock;
    stop = embeddingHostStopMock;
    destroyAndRestart = embeddingHostDestroyAndRestartMock;
  },
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    createLogger: () => ({
      debug: loggerDebug,
      error: vi.fn(),
      info: vi.fn(),
      warn: loggerWarn,
    }),
  };
});

// Use function syntax for Vitest 4 constructor mocks
vi.mock('@brainstrike/file-system/electron', () => {
  const MockAdapter = vi.fn();
  MockAdapter.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { ElectronFileSystemAdapter: MockAdapter };
});

vi.mock('@brainstrike/storage/electron', () => {
  const MockAdapter = vi.fn();
  MockAdapter.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, { clear: storageClearMock });
  });
  return { ElectronStorageAdapter: MockAdapter };
});

// Use function syntax for Vitest 4 constructor mocks
vi.mock('electron-store', () => {
  const MockElectronStore = vi.fn();
  MockElectronStore.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { default: MockElectronStore };
});

import '../../main';

export async function resetDatabaseIpcHandlerMocks(): Promise<void> {
  vi.clearAllMocks();
  // clearAllMocks intentionally preserves queued mock implementations. Reset
  // this classifier explicitly so a test that proves validation short-circuits
  // before classification cannot leak its unused `mockReturnValueOnce(true)`
  // into the next handler invocation.
  isCorruptionErrorMock.mockReset();
  isCorruptionErrorMock.mockReturnValue(false);
  const { resetDesktopDatabaseWorkSchedulerForTests, setBackgrounded } = await import(
    '../../ipc-handlers'
  );
  const { resetEmbeddingBackfillStateForTests } = await import('../../ipc-embedding-backfill');
  setBackgrounded(false);
  resetDesktopDatabaseWorkSchedulerForTests();
  resetEmbeddingBackfillStateForTests();
  browserWindowMock.getAllWindows.mockReturnValue([]);
  Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS');
  Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED');
  Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE');
  Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD');
  embeddingHostEnsureStartedMock.mockResolvedValue({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'running',
  });
  embeddingHostGetStatusMock.mockReturnValue({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'running',
  });
  embeddingHostResetMock.mockResolvedValue({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'running',
  });
  embeddingHostStopMock.mockResolvedValue({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'stopped',
  });
  embeddingHostDestroyAndRestartMock.mockResolvedValue({
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    state: 'running',
  });
}
