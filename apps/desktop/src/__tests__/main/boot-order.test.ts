import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Startup-latency contract: the visible window must NOT wait on database
 * initialization. The DB utilityProcess spawn + migrations + HNSW capability
 * probe run CONCURRENTLY with window creation; only the maintenance schedulers
 * (which consume the probed strategy) wait for the probe to finish.
 */

const mockSession = {
  defaultSession: {
    webRequest: {
      onHeadersReceived: vi.fn(),
    },
  },
};

const mockBrowserWindowInstance = {
  destroy: vi.fn(),
  getBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
  getNormalBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
  isDestroyed: vi.fn(() => false),
  isFullScreen: vi.fn(() => false),
  isMaximized: vi.fn(() => false),
  loadFile: vi.fn(() => Promise.resolve()),
  loadURL: vi.fn(() => Promise.resolve()),
  maximize: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  setFullScreen: vi.fn(),
  show: vi.fn(),
  webContents: {
    on: vi.fn(),
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  },
};

// Use function syntax for Vitest 4 constructor mocks
const mockBrowserWindow = vi.fn();
mockBrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
  Object.assign(this, mockBrowserWindowInstance);
});
Object.assign(mockBrowserWindow, {
  getAllWindows: vi.fn(() => []),
});

const mockApp = {
  commandLine: { appendSwitch: vi.fn() },
  getAppMetrics: vi.fn(() => []),
  getPath: vi.fn(() => '/tmp/brainstrike-test-logs'),
  getVersion: vi.fn(() => '0.0.0-test'),
  isPackaged: false,
  isReady: vi.fn(() => true),
  on: vi.fn(),
  quit: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  whenReady: vi.fn(() => Promise.resolve()),
};

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: {
    isStarted: vi.fn(() => true),
    start: vi.fn(() => 1),
    stop: vi.fn(),
  },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { height: 800, width: 1536, x: 0, y: 0 } }]),
  },
  session: mockSession,
  shell: {
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  },
}));

const statSyncMock = vi.fn(() => ({ isDirectory: () => true }));
const accessSyncMock = vi.fn();
const existsSyncMock = vi.fn(() => true);
vi.mock('node:fs', () => ({
  accessSync: accessSyncMock,
  constants: { W_OK: 0o200 },
  default: {
    accessSync: accessSyncMock,
    constants: { W_OK: 0o200 },
    existsSync: existsSyncMock,
    statSync: statSyncMock,
  },
  existsSync: existsSyncMock,
  statSync: statSyncMock,
}));

const { createLoggerMock } = vi.hoisted(() => ({
  createLoggerMock: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: createLoggerMock,
  };
});

vi.mock('../../assistant-server', () => ({
  startAssistantServer: vi.fn(async () => ({
    stop: vi.fn(),
    url: 'http://127.0.0.1:0',
  })),
}));

vi.mock('../../window-state', async () => {
  const actual = await vi.importActual<typeof import('../../window-state')>('../../window-state');
  return {
    ...actual,
    readStoredWindowState: vi.fn(() => null),
    registerWindowStatePersistence: vi.fn(() => vi.fn()),
  };
});

// Use function syntax for Vitest 4 constructor mocks
vi.mock('electron-store', () => {
  const MockElectronStore = vi.fn();
  MockElectronStore.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { default: MockElectronStore };
});

const { getDatabaseMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
}));

vi.mock('../../db-main', async () => {
  const actual = await vi.importActual<typeof import('../../db-main')>('../../db-main');
  return {
    ...actual,
    getDatabase: getDatabaseMock,
  };
});

const { probeMock, selectStrategyMock } = vi.hoisted(() => ({
  probeMock: vi.fn(async () => ({
    concurrentIndexBuild: true,
    hnswIndexBuild: true,
    maintenanceSettings: { maintenanceWorkMem: null, maxParallelMaintenanceWorkers: null },
    progressReporting: true,
  })),
  selectStrategyMock: vi.fn(() => ({ reason: 'test', strategy: 'rebuild-concurrently' })),
}));

vi.mock('../../dimension-index-maintenance-capabilities', async () => {
  const actual = await vi.importActual<
    typeof import('../../dimension-index-maintenance-capabilities')
  >('../../dimension-index-maintenance-capabilities');
  return {
    ...actual,
    probeDimensionIndexRuntimeCapabilities: probeMock,
    selectDimensionIndexStrategy: selectStrategyMock,
  };
});

const { databaseSchedulerStartMock, dimensionSchedulerStartMock } = vi.hoisted(() => ({
  databaseSchedulerStartMock: vi.fn(),
  dimensionSchedulerStartMock: vi.fn(),
}));

vi.mock('../../database-maintenance-scheduler', () => ({
  createDesktopDatabaseMaintenanceScheduler: vi.fn(() => ({
    start: databaseSchedulerStartMock,
    stop: vi.fn(),
  })),
}));

vi.mock('../../dimension-index-maintenance-scheduler', () => ({
  createDesktopDimensionIndexMaintenanceScheduler: vi.fn(() => ({
    start: dimensionSchedulerStartMock,
    stop: vi.fn(),
  })),
}));

describe('main boot order', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockApp.isPackaged = false;
    existsSyncMock.mockReturnValue(true);
    process.env['CI'] = 'false';
    process.argv = process.argv.filter(
      (arg) => arg !== '--test-mode' && !arg.startsWith('--brainstrike-desktop-launch-mode')
    );
  });

  it('creates and shows the main window without waiting for DB init or the capability probe', async () => {
    let resolveDatabase: ((db: unknown) => void) | undefined;
    getDatabaseMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDatabase = resolve;
        })
    );

    await import('../../main');

    // The window must come up while getDatabase() is still pending.
    await vi.waitFor(() => {
      expect(mockBrowserWindowInstance.loadFile).toHaveBeenCalled();
      expect(mockBrowserWindowInstance.show).toHaveBeenCalled();
    });
    expect(databaseSchedulerStartMock).not.toHaveBeenCalled();
    expect(dimensionSchedulerStartMock).not.toHaveBeenCalled();

    // Once the DB (and probe) complete, the maintenance schedulers start.
    resolveDatabase?.({});
    await vi.waitFor(() => {
      expect(probeMock).toHaveBeenCalledTimes(1);
      expect(databaseSchedulerStartMock).toHaveBeenCalledTimes(1);
      expect(dimensionSchedulerStartMock).toHaveBeenCalledTimes(1);
    });
  });

  it('still starts the maintenance schedulers when the capability probe fails', async () => {
    getDatabaseMock.mockResolvedValue({});
    probeMock.mockRejectedValueOnce(new Error('probe exploded'));

    await import('../../main');

    await vi.waitFor(() => {
      expect(mockBrowserWindowInstance.show).toHaveBeenCalled();
      expect(databaseSchedulerStartMock).toHaveBeenCalledTimes(1);
      expect(dimensionSchedulerStartMock).toHaveBeenCalledTimes(1);
    });
  });
});
