import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_DEV_RENDERER_URL } from '../../desktop-renderer-url';

const onHeadersReceivedMock = vi.fn();
const mockSession = {
  defaultSession: {
    webRequest: {
      onHeadersReceived: onHeadersReceivedMock,
    },
  },
};

const mockBrowserWindowInstance = {
  loadFile: vi.fn(),
  loadURL: vi.fn(),
  maximize: vi.fn(),
  setFullScreen: vi.fn(),
  isFullScreen: vi.fn(() => false),
  isMaximized: vi.fn(() => false),
  getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1536, height: 800 })),
  getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1536, height: 800 })),
  on: vi.fn(),
  isDestroyed: vi.fn(() => false),
  webContents: {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    openDevTools: vi.fn(),
  },
  once: vi.fn((event: string, handler: () => void) => {
    if (event === 'ready-to-show') {
      handler();
    }
  }),
  show: vi.fn(),
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
  isPackaged: false,
  whenReady: whenReadyMock,
  isReady: vi.fn(() => true),
  on: vi.fn(),
  getPath: vi.fn(),
  getAppMetrics: vi.fn(() => []),
  getVersion: vi.fn(() => '0.0.0-test'),
  quit: vi.fn(),
};

vi.mock('electron', () => ({
  BrowserWindow: mockBrowserWindow,
  session: mockSession,
  app: mockApp,
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1536, height: 800 } }]),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn(),
  },
  powerMonitor: {
    on: vi.fn(),
  },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    isStarted: vi.fn(() => true),
    stop: vi.fn(),
  },
}));

const statSyncMock = vi.fn(() => ({
  isDirectory: () => true,
}));
const accessSyncMock = vi.fn();
const existsSyncMock = vi.fn(() => true);
vi.mock('node:fs', () => ({
  default: {
    statSync: statSyncMock,
    accessSync: accessSyncMock,
    existsSync: existsSyncMock,
    constants: { W_OK: 0o200 },
  },
}));

const {
  applyLoggingPreferencesMock,
  createDefaultLoggingPreferencesMock,
  createLoggerMock,
  initializeLoggingMock,
  isDevEnvMock,
} = vi.hoisted(() => ({
  isDevEnvMock: vi.fn(),
  createLoggerMock: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  initializeLoggingMock: vi.fn(),
  createDefaultLoggingPreferencesMock: vi.fn(() => ({
    level: 'info',
    consoleLevel: 'info',
    includeTimestamp: false,
    consoleEnabled: true,
    redactPaths: [],
    file: {
      enabled: false,
      destination: null,
      level: 'info',
      append: true,
      mkdir: true,
    },
  })),
  applyLoggingPreferencesMock: vi.fn(),
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
    createLogger: createLoggerMock,
    initializeLogging: initializeLoggingMock,
    createDefaultLoggingPreferences: createDefaultLoggingPreferencesMock,
    applyLoggingPreferences: applyLoggingPreferencesMock,
    LogLevel: {
      TRACE: 'trace',
      DEBUG: 'debug',
      INFO: 'info',
      WARN: 'warn',
      ERROR: 'error',
      FATAL: 'fatal',
      SILENT: 'silent',
    },
  };
});

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: createLoggerMock,
  };
});

vi.mock('@brainstrike/utils/logging-initializer', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logging-initializer')>(
    '@brainstrike/utils/logging-initializer'
  );
  return {
    ...actual,
    initializeLogging: initializeLoggingMock,
  };
});

vi.mock('@brainstrike/utils/logging-preferences', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logging-preferences')>(
    '@brainstrike/utils/logging-preferences'
  );
  return {
    ...actual,
    createDefaultLoggingPreferences: createDefaultLoggingPreferencesMock,
    applyLoggingPreferences: applyLoggingPreferencesMock,
  };
});

vi.mock('../../assistant-server', () => ({
  startAssistantServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:0',
    stop: vi.fn(),
  })),
}));

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
        level: 'info',
        consoleLevel: 'warn',
        file: expect.objectContaining({
          level: 'info',
        }),
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

    const attemptedUrls = mockBrowserWindowInstance.loadURL.mock.calls.map(
      (call: [string]) => call[0]
    );
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
