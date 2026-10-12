import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_DEV_RENDERER_URL } from '../../desktop-renderer-url';

const onHeadersReceivedMock = vi.fn();
const mockSession = {
  defaultSession: {
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: {
      onHeadersReceived: onHeadersReceivedMock,
    },
  },
};

const mockBrowserWindowInstance = {
  getBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
  getNormalBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
  isDestroyed: vi.fn(() => false),
  isFullScreen: vi.fn(() => false),
  isMaximized: vi.fn(() => false),
  loadFile: vi.fn(),
  loadURL: vi.fn<(url: string) => Promise<void>>(),
  maximize: vi.fn(),
  on: vi.fn(),
  once: vi.fn((event: string, handler: () => void) => {
    if (event === 'ready-to-show') {
      handler();
    }
  }),
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

const whenReadyMock = vi.fn(() => Promise.resolve());

const mockApp = {
  commandLine: { appendSwitch: vi.fn() },
  getAppMetrics: vi.fn(() => []),
  getAppPath: vi.fn(() => resolve('/mock/app')),
  getPath: vi.fn(),
  getVersion: vi.fn(() => '0.0.0-test'),
  isPackaged: false,
  isReady: vi.fn(() => true),
  on: vi.fn(),
  quit: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  setPath: vi.fn(),
  whenReady: whenReadyMock,
};

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  clipboard: {
    writeText: vi.fn(),
  },
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
    getAllDisplays: vi.fn(() => [{ workArea: { height: 800, width: 1536, x: 0, y: 0 } }]),
  },
  session: mockSession,
  shell: {
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  },
}));

const statSyncMock = vi.fn(() => ({
  isDirectory: () => true,
}));
const accessSyncMock = vi.fn();
const existsSyncMock = vi.fn(() => true);
vi.mock('node:fs', () => ({
  default: {
    accessSync: accessSyncMock,
    constants: { W_OK: 0o200 },
    existsSync: existsSyncMock,
    mkdirSync: vi.fn(),
    statSync: statSyncMock,
  },
}));

const {
  applyLoggingPreferencesMock,
  createDefaultLoggingPreferencesMock,
  createLoggerMock,
  initializeLoggingMock,
  isDevEnvMock,
} = vi.hoisted(() => ({
  applyLoggingPreferencesMock: vi.fn(),
  createDefaultLoggingPreferencesMock: vi.fn(() => ({
    consoleEnabled: true,
    consoleLevel: 'info',
    file: {
      append: true,
      destination: null,
      enabled: false,
      level: 'info',
      mkdir: true,
    },
    includeTimestamp: false,
    level: 'info',
    redactPaths: [],
  })),
  createLoggerMock: vi.fn((_scope: string) => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
  initializeLoggingMock: vi.fn(),
  isDevEnvMock: vi.fn(),
}));

const getLoggerInstance = (scope: string) => {
  const index = createLoggerMock.mock.calls.findIndex(([arg]) => arg === scope);
  return index === -1 ? undefined : createLoggerMock.mock.results[index]?.value;
};
vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    isDevEnv: isDevEnvMock,
  };
});

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    applyLoggingPreferences: applyLoggingPreferencesMock,
    createDefaultLoggingPreferences: createDefaultLoggingPreferencesMock,
    createLogger: createLoggerMock,
    initializeLogging: initializeLoggingMock,
    LogLevel: {
      DEBUG: 'debug',
      ERROR: 'error',
      FATAL: 'fatal',
      INFO: 'info',
      SILENT: 'silent',
      TRACE: 'trace',
      WARN: 'warn',
    },
  };
});

vi.mock('../../window-state', async () => {
  const actual = await vi.importActual<typeof import('../../window-state')>('../../window-state');
  return {
    ...actual,
    readStoredWindowState: vi.fn(() => null),
    registerWindowStatePersistence: vi.fn(),
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

describe('window setup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockApp.getPath.mockReturnValue('/tmp/brainstrike-test-logs');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DESKTOP_OPEN_DEVTOOLS');
  });

  it('setupSecurity dev mode sets dev CSP and logs when isDevEnv is true', async () => {
    mockApp.isPackaged = false;
    isDevEnvMock.mockReturnValue(true);

    const { setupSecurity } = await import('../../setup-security');
    setupSecurity();

    expect(onHeadersReceivedMock).toHaveBeenCalledTimes(1);
    const handler = onHeadersReceivedMock.mock.calls.at(-1)?.[0] as (
      details: { responseHeaders?: Record<string, string[]> },
      callback: (r: { responseHeaders: Record<string, string[]> }) => void
    ) => void;
    const cb = vi.fn();
    handler?.({ responseHeaders: {} }, cb);
    expect(cb.mock.calls[0]?.[0].responseHeaders['Content-Security-Policy'][0]).toContain(
      'localhost:*'
    );
    const securityLogger = getLoggerInstance('DesktopSecurity');
    expect(securityLogger?.info).toHaveBeenCalledWith(
      'CSP configured',
      expect.objectContaining({
        mode: 'Development',
        policy: expect.any(String),
      })
    );
  });

  it('desktop logging defaults persistent logs to info and renderer console output to warn', async () => {
    mockApp.isPackaged = false;
    isDevEnvMock.mockReturnValue(false);
    whenReadyMock.mockReturnValueOnce(new Promise(() => {}));

    await import('../../main');

    expect(createDefaultLoggingPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        consoleLevel: 'warn',
        file: expect.objectContaining({
          level: 'info',
        }),
        level: 'info',
      })
    );
  });

  it('setupSecurity prod mode sets restrictive CSP', async () => {
    mockApp.isPackaged = true;
    isDevEnvMock.mockReturnValue(false);

    const { setupSecurity } = await import('../../setup-security');
    setupSecurity();

    expect(onHeadersReceivedMock).toHaveBeenCalledTimes(1);
    const handler = onHeadersReceivedMock.mock.calls.at(-1)?.[0] as (
      details: { responseHeaders?: Record<string, string[]> },
      callback: (r: { responseHeaders: Record<string, string[]> }) => void
    ) => void;
    const cb = vi.fn();
    handler?.({ responseHeaders: {} }, cb);
    const csp = cb.mock.calls[0]?.[0].responseHeaders['Content-Security-Policy'][0];
    // Match against the canonical generator to avoid brittle ordering issues
    const { getCSP } = await import('../../csp-utils');
    expect(csp).toBe(getCSP('production'));
  });

  it('createWindow dev mode uses deterministic URL without auto-opening dev tools', async () => {
    mockApp.isPackaged = false;
    existsSyncMock.mockReturnValue(false);
    isDevEnvMock.mockReturnValue(false);
    process.env['CI'] = 'false';
    process.argv.push('--brainstrike-desktop-launch-mode=dev-server');

    mockBrowserWindowInstance.loadURL.mockResolvedValueOnce(undefined);

    const { createWindow } = await import('../../main');
    await createWindow();

    const attemptedUrls = mockBrowserWindowInstance.loadURL.mock.calls.map((call) => call[0]);
    expect(attemptedUrls).toContain(DESKTOP_DEV_RENDERER_URL);
    for (const url of attemptedUrls.filter((value) => !value.includes('?mode=embedding-host'))) {
      expect(url).toBe(DESKTOP_DEV_RENDERER_URL);
    }
    expect(mockBrowserWindowInstance.webContents.openDevTools).not.toHaveBeenCalled();
  });

  it('createWindow dev mode opens dev tools only when explicitly enabled', async () => {
    mockApp.isPackaged = false;
    existsSyncMock.mockReturnValue(false);
    isDevEnvMock.mockReturnValue(false);
    process.env['CI'] = 'false';
    process.env['BRAINSTRIKE_DESKTOP_OPEN_DEVTOOLS'] = '1';
    process.argv.push('--brainstrike-desktop-launch-mode=dev-server');
    mockBrowserWindowInstance.loadURL.mockResolvedValueOnce(undefined);

    const { createWindow } = await import('../../main');
    const win = await createWindow();

    expect(mockBrowserWindowInstance.loadURL).toHaveBeenCalledWith(DESKTOP_DEV_RENDERER_URL);
    expect(mockBrowserWindowInstance.webContents.openDevTools).toHaveBeenCalled();
    // Vitest 4 constructor mocks return `this`, not the original mock object
    // Verify win has the expected mock functions attached
    expect(win.loadURL).toBeDefined();
    expect(win.loadFile).toBeDefined();
  });

  it('sets disable-features with MacWebContentsOcclusion and SpareRendererForSitePerProcess', async () => {
    await import('../../main');
    expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      expect.stringContaining('MacWebContentsOcclusion')
    );
    expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      expect.stringContaining('SpareRendererForSitePerProcess')
    );
  });

  it('does NOT enable gpu-rasterization or zero-copy flags', async () => {
    await import('../../main');
    const calls = mockApp.commandLine.appendSwitch.mock.calls as [string, string][];
    for (const [key, value] of calls) {
      const combined = `${key}=${value ?? ''}`;
      expect(combined).not.toMatch(/enable-gpu-rasterization/);
      expect(combined).not.toMatch(/enable-zero-copy/);
    }
  });
});
