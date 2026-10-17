import { afterEach, beforeEach, vi } from 'vitest';
import type { DesktopShutdownRunPlan } from '../../main/desktop-graceful-shutdown';

/** Main startup uses the native profile and reader owners. */

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
  setPath: vi.fn(),
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
    mkdirSync: vi.fn(),
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

const { applicationDomainCapture } = vi.hoisted(() => ({
  applicationDomainCapture: {
    close: null as null | ReturnType<typeof vi.fn<() => Promise<void>>>,
    options: null as
      | null
      | Parameters<typeof import('../../ipc-handlers').createApplicationIpcDomain>[3],
  },
}));

vi.mock('../../ipc-handlers', async () => {
  const actual = await vi.importActual<typeof import('../../ipc-handlers')>('../../ipc-handlers');
  return {
    ...actual,
    createApplicationIpcDomain: (...args: Parameters<typeof actual.createApplicationIpcDomain>) => {
      const domain = actual.createApplicationIpcDomain(...args);
      const close = vi.fn(() => domain.close());
      applicationDomainCapture.close = close;
      applicationDomainCapture.options = args[3];
      return { ...domain, close };
    },
  };
});

const {
  nativeActualPrepareForPause,
  nativeAcquireProfile,
  nativeAcquire,
  nativeAcquireRead,
  nativeCloseForShutdown,
  nativePrepareForPause,
  nativeReconfigureForReset,
  publicEmbeddingStop,
} = vi.hoisted(() => ({
  nativeAcquire: vi.fn<() => Promise<void>>(async () => undefined),
  nativeAcquireProfile: vi.fn<() => Promise<void>>(() => new Promise(() => undefined)),
  nativeAcquireRead: vi.fn<() => Promise<void>>(async () => undefined),
  nativeActualPrepareForPause: {
    current: null as
      | null
      | ReturnType<
          typeof import('../../native-index-activation').createNativeIndexActivation
        >['prepareSavedPause'],
  },
  nativeCloseForShutdown: vi.fn(async (): Promise<void> => undefined),
  nativePrepareForPause: vi.fn<
    ReturnType<
      typeof import('../../native-index-activation').createNativeIndexActivation
    >['prepareSavedPause']
  >(async () => null),
  nativeReconfigureForReset: { current: null as null | (() => Promise<void>) },
  publicEmbeddingStop: {
    current: null as null | import('../../embedding-host-manager').EmbeddingHostManager['stop'],
  },
}));
vi.mock('../../native-index-activation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../native-index-activation')>();
  return {
    ...actual,
    createNativeIndexActivation: (
      ...args: Parameters<typeof actual.createNativeIndexActivation>
    ) => {
      const owner = actual.createNativeIndexActivation(...args);
      nativeActualPrepareForPause.current = owner.prepareSavedPause;
      return {
        ...owner,
        acquire: nativeAcquire,
        acquireProfile: nativeAcquireProfile,
        acquireRead: nativeAcquireRead,
        close: nativeCloseForShutdown,
        prepareSavedPause: nativePrepareForPause,
        reconfigure: () => nativeReconfigureForReset.current?.() ?? owner.reconfigure(),
      };
    },
  };
});

vi.mock('../../ipc-embedding-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ipc-embedding-host')>();
  return {
    registerEmbeddingHostIpcHandlers: (
      ...args: Parameters<typeof actual.registerEmbeddingHostIpcHandlers>
    ) => {
      publicEmbeddingStop.current = args[1].stop;
      return actual.registerEmbeddingHostIpcHandlers(...args);
    },
  };
});

const { shutdownPlanCapture } = vi.hoisted(() => ({
  shutdownPlanCapture: {
    current: null as null | (() => DesktopShutdownRunPlan),
    run: null as null | ReturnType<typeof vi.fn>,
  },
}));

vi.mock('../../main/desktop-graceful-shutdown', () => ({
  createDesktopGracefulShutdown: vi.fn(
    (options: { readonly planRun: () => DesktopShutdownRunPlan }) => {
      shutdownPlanCapture.current = options.planRun;
      shutdownPlanCapture.run = vi.fn(async () => undefined);
      return { run: shutdownPlanCapture.run };
    }
  ),
}));

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

/** The logger `main.ts` made for 'DesktopMain'; fails loudly rather than reading the last one. */
function requireMainLogger() {
  const index = createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain');
  const logger = index === -1 ? undefined : createLoggerMock.mock.results[index]?.value;
  if (!logger) {
    throw new Error("main.ts never created its 'DesktopMain' logger");
  }
  return logger;
}

export function installMainBootFixture(): void {
  let uncaughtExceptionListenersBeforeMain = new Set<unknown>();
  let unhandledRejectionListenersBeforeMain = new Set<unknown>();

  beforeEach(() => {
    uncaughtExceptionListenersBeforeMain = new Set(process.listeners('uncaughtException'));
    unhandledRejectionListenersBeforeMain = new Set(process.listeners('unhandledRejection'));
    vi.resetModules();
    vi.clearAllMocks();
    nativeAcquireProfile.mockReset().mockImplementation(() => new Promise(() => undefined));
    nativeAcquire.mockReset().mockResolvedValue(undefined);
    nativeAcquireRead.mockReset().mockResolvedValue(undefined);
    nativeCloseForShutdown.mockReset().mockResolvedValue(undefined);
    shutdownPlanCapture.current = null;
    shutdownPlanCapture.run = null;
    applicationDomainCapture.close = null;
    applicationDomainCapture.options = null;
    nativeReconfigureForReset.current = null;
    nativeActualPrepareForPause.current = null;
    nativePrepareForPause.mockReset().mockResolvedValue(null);
    publicEmbeddingStop.current = null;
    isDesktopShuttingDownMock.mockReturnValue(false);
    mockApp.isPackaged = false;
    existsSyncMock.mockReturnValue(true);
    process.env['CI'] = 'false';
    process.argv = process.argv.filter(
      (arg) => arg !== '--test-mode' && !arg.startsWith('--brainstrike-desktop-launch-mode')
    );
  });

  afterEach(() => {
    for (const listener of process.listeners('uncaughtException')) {
      if (!uncaughtExceptionListenersBeforeMain.has(listener)) {
        process.off('uncaughtException', listener);
      }
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!unhandledRejectionListenersBeforeMain.has(listener)) {
        process.off('unhandledRejection', listener);
      }
    }
  });
}

export {
  applicationDomainCapture,
  createLoggerMock,
  existsSyncMock,
  isDesktopShuttingDownMock,
  mockApp,
  mockBrowserWindowInstance,
  nativeAcquire,
  nativeAcquireProfile,
  nativeAcquireRead,
  nativeActualPrepareForPause,
  nativeCloseForShutdown,
  nativePrepareForPause,
  nativeReconfigureForReset,
  publicEmbeddingStop,
  requireMainLogger,
  shutdownPlanCapture,
};
