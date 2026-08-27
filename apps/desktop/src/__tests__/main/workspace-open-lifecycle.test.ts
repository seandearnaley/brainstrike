import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

/**
 * BST-1393 Layer 3: argv / macOS `open-file` / `second-instance` all funnel
 * into the SAME `workspace-open-queue`, which holds requests until the
 * renderer's `did-finish-load` fires and then delivers them over
 * `workspace:open-path`. This harness mirrors `boot-order.test.ts`'s mock
 * shape (read at HEAD) — see that file's own header comment for the
 * "Vitest 4 constructor mock" pattern this reuses verbatim.
 */

const mockSession = {
  defaultSession: {
    webRequest: {
      onHeadersReceived: vi.fn(),
    },
  },
  // The embedded browser pane (`browser-session.ts`) resolves its own
  // partitioned session during `createMainWindow`'s `createBrowserPaneHost`
  // call — needed for that call to resolve at all, not for anything this
  // file asserts on.
  fromPartition: vi.fn(() => ({
    clearStorageData: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  })),
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
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    openDevTools: vi.fn(),
    send: vi.fn(),
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

vi.mock('../../database-maintenance-scheduler', () => ({
  createDesktopDatabaseMaintenanceScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../dimension-index-maintenance-scheduler', () => ({
  createDesktopDimensionIndexMaintenanceScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

function findHandler<T extends (...args: never[]) => unknown>(
  onMock: ReturnType<typeof vi.fn>,
  eventName: string
): T {
  const call = onMock.mock.calls.find((args) => args[0] === eventName);
  if (!call) {
    throw new Error(`No handler registered for "${eventName}"`);
  }
  return call[1] as T;
}

/**
 * `did-finish-load` has more than one subscriber on the main window
 * (`create-window.ts` registers its own); the queue's attach listener is
 * this file's newest one, but rather than assume registration order, invoke
 * every registered handler for the event — exactly what a real
 * `webContents.emit('did-finish-load')` would do.
 */
function fireAllHandlers(onMock: ReturnType<typeof vi.fn>, eventName: string): void {
  const handlers = onMock.mock.calls
    .filter((args) => args[0] === eventName)
    .map((args) => args[1] as () => void);
  if (handlers.length === 0) {
    throw new Error(`No handler registered for "${eventName}"`);
  }
  for (const handler of handlers) {
    handler();
  }
}

describe('main workspace-open lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockApp.isPackaged = false;
    getDatabaseMock.mockResolvedValue({});
    existsSyncMock.mockReturnValue(true);
    process.env['CI'] = 'false';
    process.argv = process.argv.filter(
      (arg) =>
        arg !== '--test-mode' &&
        !arg.startsWith('--brainstrike-desktop-launch-mode') &&
        !arg.startsWith('/work/')
    );
  });

  it('registers an open-file listener at module scope', async () => {
    await import('../../main');

    expect(mockApp.on).toHaveBeenCalledWith('open-file', expect.any(Function));
  });

  it('queues an open-file request fired before the window loads, then delivers it once did-finish-load fires', async () => {
    await import('../../main');

    // Fires BEFORE any renderer is listening — the whole point of the queue.
    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    const preventDefault = vi.fn();
    openFileHandler({ preventDefault }, '/Users/dev/repo');
    expect(preventDefault).toHaveBeenCalledTimes(1);

    // No renderer attached yet: nothing sent.
    expect(mockBrowserWindowInstance.webContents.send).not.toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.workspace.openPath,
      expect.anything()
    );

    await vi.waitFor(() => {
      expect(mockBrowserWindowInstance.webContents.on).toHaveBeenCalledWith(
        'did-finish-load',
        expect.any(Function)
      );
    });
    fireAllHandlers(mockBrowserWindowInstance.webContents.on, 'did-finish-load');

    expect(mockBrowserWindowInstance.webContents.send).toHaveBeenCalledExactlyOnceWith(
      DESKTOP_IPC_CHANNELS.workspace.openPath,
      { origin: 'open-file', path: '/Users/dev/repo' }
    );
  });

  it('registers second-instance with a handler that accepts argv and a working directory', async () => {
    await import('../../main');

    const secondInstanceHandler = findHandler(mockApp.on, 'second-instance');
    // Arity, not behavior: the non-e2e branch's show/focus body needs a real
    // BrowserWindow instance this harness does not simulate end to end
    // (BST-1393 ruling L3 — no e2e is invented for second-instance).
    expect(secondInstanceHandler.length).toBeGreaterThanOrEqual(3);
  });

  it('enqueues and delivers a launch-argv folder exactly once', async () => {
    process.argv = [...process.argv, '/work/argv-repo'];

    await import('../../main');

    await vi.waitFor(() => {
      expect(mockBrowserWindowInstance.webContents.on).toHaveBeenCalledWith(
        'did-finish-load',
        expect.any(Function)
      );
    });
    fireAllHandlers(mockBrowserWindowInstance.webContents.on, 'did-finish-load');
    // Idempotent re-attach must not redeliver the same request.
    fireAllHandlers(mockBrowserWindowInstance.webContents.on, 'did-finish-load');

    const argvSends = mockBrowserWindowInstance.webContents.send.mock.calls.filter(
      ([channel, payload]) =>
        channel === DESKTOP_IPC_CHANNELS.workspace.openPath &&
        (payload as { origin: string }).origin === 'argv'
    );
    expect(argvSends).toHaveLength(1);
    expect(argvSends[0]?.[1]).toEqual({ origin: 'argv', path: '/work/argv-repo' });
  });
});
