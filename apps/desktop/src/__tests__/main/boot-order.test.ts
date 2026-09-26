import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopShutdownRunPlan } from '../../main/desktop-graceful-shutdown';

/**
 * Startup-latency contract: the visible window must NOT wait on database
 * initialization. The DB utilityProcess spawn + migrations + HNSW capability
 * probe run CONCURRENTLY with window creation; only the maintenance schedulers
 * (which consume the probed strategy) wait for the probe to finish.
 */

const mockSession = {
  defaultSession: {
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
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
  getAppPath: vi.fn(() => '/mock/app'),
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
  createLoggerMock: vi.fn((_scope: string) => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
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

const { closeDatabaseMock, getDatabaseMock } = vi.hoisted(() => ({
  closeDatabaseMock: vi.fn(async (): Promise<void> => undefined),
  getDatabaseMock: vi.fn(),
}));

vi.mock('../../db-main', async () => {
  const actual = await vi.importActual<typeof import('../../db-main')>('../../db-main');
  return {
    ...actual,
    closeDatabase: closeDatabaseMock,
    getDatabase: getDatabaseMock,
  };
});

const { recoverInterruptedMaintenanceMock } = vi.hoisted(() => ({
  recoverInterruptedMaintenanceMock: vi.fn(async (): Promise<number> => 0),
}));

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    recoverInterruptedDimensionIndexMaintenanceAtStartup: recoverInterruptedMaintenanceMock,
  };
});

const { cleanupSubscriptionsMock, waitForDatabaseIdleMock } = vi.hoisted(() => ({
  cleanupSubscriptionsMock: vi.fn(async (): Promise<void> => undefined),
  waitForDatabaseIdleMock: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('../../ipc-handlers', async () => {
  const actual = await vi.importActual<typeof import('../../ipc-handlers')>('../../ipc-handlers');
  return {
    ...actual,
    cleanupDesktopLiveSubscriptionsForShutdown: cleanupSubscriptionsMock,
    waitForDesktopDatabaseWorkSchedulerIdle: waitForDatabaseIdleMock,
  };
});

const { shutdownPlanCapture } = vi.hoisted(() => ({
  shutdownPlanCapture: {
    current: null as null | (() => DesktopShutdownRunPlan),
  },
}));

vi.mock('../../main/desktop-graceful-shutdown', () => ({
  createDesktopGracefulShutdown: vi.fn(
    (options: { readonly planRun: () => DesktopShutdownRunPlan }) => {
      shutdownPlanCapture.current = options.planRun;
      return { run: vi.fn(async () => undefined) };
    }
  ),
}));

const { probeMock } = vi.hoisted(() => ({
  probeMock: vi.fn(async () => ({
    hnswIndexBuild: true,
    maintenanceSettings: { maintenanceWorkMem: null, maxParallelMaintenanceWorkers: null },
    progressReporting: true,
  })),
}));

vi.mock('../../dimension-index-maintenance-capabilities', async () => {
  const actual = await vi.importActual<
    typeof import('../../dimension-index-maintenance-capabilities')
  >('../../dimension-index-maintenance-capabilities');
  return {
    ...actual,
    probeDimensionIndexRuntimeCapabilities: probeMock,
  };
});

const { isDesktopShuttingDownMock } = vi.hoisted(() => ({
  isDesktopShuttingDownMock: vi.fn(() => false),
}));

vi.mock('../../desktop-shutdown-state', async () => {
  const actual = await vi.importActual<typeof import('../../desktop-shutdown-state')>(
    '../../desktop-shutdown-state'
  );
  return {
    ...actual,
    isDesktopShuttingDown: isDesktopShuttingDownMock,
  };
});

const { maintenanceCloseMock, maintenanceStartMock, maintenanceStopMock } = vi.hoisted(() => ({
  maintenanceCloseMock: vi.fn(async (): Promise<void> => undefined),
  maintenanceStartMock: vi.fn(async (): Promise<void> => undefined),
  maintenanceStopMock: vi.fn(),
}));

vi.mock('../../database-maintenance-scheduler', () => ({
  createDesktopDatabaseMaintenanceScheduler: vi.fn(() => ({})),
}));

vi.mock('../../dimension-index-maintenance-scheduler', () => ({
  createDesktopDimensionIndexMaintenanceScheduler: vi.fn(() => ({})),
}));

vi.mock('../../desktop-maintenance-trigger-graph', () => ({
  createDesktopMaintenanceTriggerGraph: vi.fn(() => ({
    close: maintenanceCloseMock,
    start: maintenanceStartMock,
    stop: maintenanceStopMock,
  })),
}));

describe('main boot order', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    shutdownPlanCapture.current = null;
    isDesktopShuttingDownMock.mockReturnValue(false);
    closeDatabaseMock.mockResolvedValue(undefined);
    cleanupSubscriptionsMock.mockResolvedValue(undefined);
    waitForDatabaseIdleMock.mockResolvedValue(undefined);
    maintenanceCloseMock.mockResolvedValue(undefined);
    maintenanceStartMock.mockResolvedValue(undefined);
    recoverInterruptedMaintenanceMock.mockResolvedValue(0);
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
    expect(maintenanceStartMock).not.toHaveBeenCalled();

    // Once the DB (and probe) complete, the maintenance schedulers start.
    resolveDatabase?.({});
    await vi.waitFor(() => {
      expect(probeMock).toHaveBeenCalledTimes(1);
      expect(maintenanceStartMock).toHaveBeenCalledTimes(1);
    });
    expect(recoverInterruptedMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(recoverInterruptedMaintenanceMock.mock.invocationCallOrder[0]).toBeLessThan(
      probeMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(probeMock.mock.invocationCallOrder[0]).toBeLessThan(
      maintenanceStartMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('does not start maintenance when exclusive boot recovery fails', async () => {
    getDatabaseMock.mockResolvedValue({});
    recoverInterruptedMaintenanceMock.mockRejectedValueOnce(new Error('recovery failed'));

    await import('../../main');

    await vi.waitFor(() => expect(recoverInterruptedMaintenanceMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalled());
    expect(probeMock).not.toHaveBeenCalled();
    expect(maintenanceStartMock).not.toHaveBeenCalled();
  });

  it('still starts the maintenance schedulers when the capability probe fails', async () => {
    getDatabaseMock.mockResolvedValue({});
    probeMock.mockRejectedValueOnce(new Error('probe exploded'));

    await import('../../main');

    await vi.waitFor(() => {
      expect(mockBrowserWindowInstance.show).toHaveBeenCalled();
      expect(maintenanceStartMock).toHaveBeenCalledTimes(1);
    });
  });

  it('logs each error from a partial maintenance graph acquisition', async () => {
    getDatabaseMock.mockResolvedValue({});
    maintenanceStartMock.mockRejectedValueOnce(
      new AggregateError([new Error('dimension timer failed'), undefined], 'Acquisition failed')
    );

    await import('../../main');

    const mainLogger = createLoggerMock.mock.results
      .map((result) => result.value)
      .at(createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain'));
    await vi.waitFor(() =>
      expect(mainLogger?.error).toHaveBeenCalledWith(
        'Failed to start desktop maintenance schedulers',
        {
          error: expect.objectContaining({
            errors: [
              expect.objectContaining({ message: 'dimension timer failed' }),
              { message: 'undefined' },
            ],
          }),
        }
      )
    );
  });

  it('does not start maintenance after a probe finishes during shutdown', async () => {
    // The probe now runs concurrently with the app lifecycle. A short-lived
    // session (e2e apps, quick open/quit) can tear the DB down mid-probe;
    // that rejection is an EXPECTED teardown per desktop-shutdown-state and
    // must not produce an alarming error-level log on every fast quit.
    getDatabaseMock.mockResolvedValue({});
    probeMock.mockImplementationOnce(async () => {
      isDesktopShuttingDownMock.mockReturnValue(true);
      throw new Error('db host disposed');
    });

    await import('../../main');

    await vi.waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalled());
    expect(maintenanceStartMock).not.toHaveBeenCalled();

    const mainLogger = createLoggerMock.mock.results
      .map((result) => result.value)
      .at(createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain'));
    const errorMessages = (mainLogger?.error.mock.calls ?? []).map(
      ([message]: [string]) => message
    );
    expect(errorMessages).not.toContain('Dimension index maintenance capability probe failed');
    const infoMessages = (mainLogger?.info.mock.calls ?? []).map(([message]: [string]) => message);
    expect(infoMessages).toContain(
      'Dimension index maintenance capability probe aborted by shutdown'
    );
  });

  it('fences the paired maintenance owner before joining trigger close and the database lane', async () => {
    getDatabaseMock.mockResolvedValue({});
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    if (!planRun) {
      throw new Error('Shutdown plan was not registered');
    }

    let releaseTriggerClose: (() => void) | undefined;
    maintenanceCloseMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTriggerClose = resolve;
        })
    );
    const step = planRun().steps.database(new AbortController().signal);

    expect(maintenanceStopMock).toHaveBeenCalledTimes(1);
    expect(maintenanceCloseMock).toHaveBeenCalledTimes(1);
    expect(waitForDatabaseIdleMock).not.toHaveBeenCalled();

    releaseTriggerClose?.();
    await step;
    expect(waitForDatabaseIdleMock).toHaveBeenCalledTimes(1);
    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
  });

  it('still drains and closes the database when trigger cleanup rejects undefined', async () => {
    getDatabaseMock.mockResolvedValue({});
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    if (!planRun) {
      throw new Error('Shutdown plan was not registered');
    }
    maintenanceCloseMock.mockRejectedValueOnce(undefined);

    await expect(planRun().steps.database(new AbortController().signal)).rejects.toMatchObject({
      errors: [undefined],
    });
    expect(cleanupSubscriptionsMock).toHaveBeenCalledTimes(2);
    expect(waitForDatabaseIdleMock).toHaveBeenCalledTimes(1);
    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
  });

  it('retains the existing database failure path when the idle join rejects', async () => {
    getDatabaseMock.mockResolvedValue({});
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    if (!planRun) {
      throw new Error('Shutdown plan was not registered');
    }
    waitForDatabaseIdleMock.mockRejectedValueOnce(undefined);

    await expect(planRun().steps.database(new AbortController().signal)).rejects.toBeUndefined();
    expect(cleanupSubscriptionsMock).toHaveBeenCalledTimes(1);
    expect(closeDatabaseMock).not.toHaveBeenCalled();
  });
});
