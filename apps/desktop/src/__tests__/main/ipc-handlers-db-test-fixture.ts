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
  parseManagedCacheBatchArgsMock,
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
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockDb = {
    query: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    live: {
      query: vi.fn(),
      incrementalQuery: vi.fn(),
    },
  };
  const browserWindowMock = Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
  });
  const applyManagedCacheBatchMock = vi.fn(async () => undefined);
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
  const getDatabaseMock = vi.fn(() => mockDb);
  const loggerWarn = vi.fn();
  const loggerDebug = vi.fn();
  const isCorruptionErrorMock = vi.fn(() => false);
  const handleRuntimeCorruptionMock = vi.fn();
  const resetLocalDatabaseMock = vi.fn();
  const closeDatabaseMock = vi.fn();
  const resetDesktopApplicationDataMock = vi.fn(async () => ({
    deletedPaths: [],
    pendingDeletionPaths: [],
    preservedPaths: [],
  }));
  const enqueueEmbeddingBackfillMock = vi.fn();
  const embeddingHostIsHostWindowMock = vi.fn(() => false);
  const embeddingHostEnsureStartedMock = vi.fn(async () => ({
    state: 'running' as const,
    active: false,
    lastError: null,
  }));
  const embeddingHostGetStatusMock = vi.fn(() => ({
    state: 'running' as const,
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  }));
  const embeddingHostResetMock = vi.fn(async () => ({
    state: 'running' as const,
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  }));
  const embeddingHostStopMock = vi.fn(async () => ({
    state: 'stopped' as const,
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  }));
  const embeddingHostDestroyAndRestartMock = vi.fn(async () => ({
    state: 'running' as const,
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  }));
  const getDatabaseDiagnosticsMock = vi.fn(() => ({
    databaseProfile: 'test',
    dataDir: '/mock/documents/BrainStrike-dev/profiles/test/pgdata',
    appDataDir: '/mock/documents/BrainStrike-dev/profiles/test',
    nodeEnv: 'test',
    initializationAttemptCount: 1,
    initializationInFlight: false,
    hasDatabaseHandle: true,
    databaseLockHeld: true,
    databaseLockPath: '/mock/documents/BrainStrike-dev/profiles/test/.db-process.lock',
    lastInitializationStartedAt: '2026-02-15T00:00:00.000Z',
    lastInitializationSucceededAt: '2026-02-15T00:00:01.000Z',
    lastInitializationFailure: null,
    runtimeCorruptionRecoveryCount: 0,
    lastRuntimeCorruptionAt: null,
    lastRuntimeCorruptionContext: null,
  }));
  const getDbHostManagerMock = vi.fn(() => ({
    applyManagedCacheBatch: applyManagedCacheBatchMock,
    getDiagnostics: getDatabaseDiagnosticsMock,
  }));
  return {
    handlers,
    mockDb,
    browserWindowMock,
    applyManagedCacheBatchMock,
    parseManagedCacheBatchArgsMock,
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
  isCorruptionErrorMock,
  loggerDebug,
  loggerWarn,
  mockDb,
  parseManagedCacheBatchArgsMock,
  resetDesktopApplicationDataMock,
  resetLocalDatabaseMock,
};

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    applyManagedCacheBatch: applyManagedCacheBatchMock,
    parseManagedCacheBatchArgs: parseManagedCacheBatchArgsMock,
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
    whenReadyResolved: true,
    documentsPath: '/mock/documents',
  });
  const mockBrowserWindowInstance = {
    once: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    destroy: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    maximize: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1536, height: 800 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1536, height: 800 })),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      openDevTools: vi.fn(),
    },
  };
  browserWindowMock.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, mockBrowserWindowInstance);
  });
  return {
    ipcMain: typedIpcMain,
    app,
    BrowserWindow: browserWindowMock,
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn(),
    },
    screen: {
      getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })),
      getAllDisplays: vi.fn(() => []),
    },
    powerMonitor: {
      on: vi.fn(),
    },
    powerSaveBlocker: {
      start: vi.fn(() => 1),
      isStarted: vi.fn(() => true),
      stop: vi.fn(),
    },
    shell: {
      openPath: vi.fn().mockResolvedValue(''),
      showItemInFolder: vi.fn(),
    },
  };
});

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
  isCorruptionError: isCorruptionErrorMock,
  handleRuntimeCorruption: handleRuntimeCorruptionMock,
  resetLocalDatabase: resetLocalDatabaseMock,
  closeDatabase: closeDatabaseMock,
  getDatabaseDiagnostics: getDatabaseDiagnosticsMock,
}));

vi.mock('../../db-host-manager', () => ({
  getDbHostManager: getDbHostManagerMock,
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

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: () => ({
      warn: loggerWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: loggerDebug,
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
    Object.assign(this, {});
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
    state: 'running',
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  });
  embeddingHostGetStatusMock.mockReturnValue({
    state: 'running',
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  });
  embeddingHostResetMock.mockResolvedValue({
    state: 'running',
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  });
  embeddingHostStopMock.mockResolvedValue({
    state: 'stopped',
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  });
  embeddingHostDestroyAndRestartMock.mockResolvedValue({
    state: 'running',
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  });
}
