import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const whenReadyMock = vi.fn(() => Promise.resolve());

const mockApp = {
  commandLine: { appendSwitch: vi.fn() },
  isPackaged: false,
  whenReady: whenReadyMock,
  isReady: vi.fn(() => true),
  on: vi.fn(),
  getPath: vi.fn(),
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
  ipcMain: { handle: vi.fn() },
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn(),
  },
  powerMonitor: {
    on: vi.fn(),
  },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
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

const isDevEnvMock = vi.fn();
const createLoggerMock = vi.fn(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const getLoggerInstance = (scope: string) => {
  const index = createLoggerMock.mock.calls.findIndex(([arg]) => arg === scope);
  return index === -1 ? undefined : createLoggerMock.mock.results[index]?.value;
};
const initializeLoggingMock = vi.fn();
const createDefaultLoggingPreferencesMock = vi.fn(() => ({
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
}));
const applyLoggingPreferencesMock = vi.fn();
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

    const { setupSecurity } = await import('../../main');
    setupSecurity();

    expect(onHeadersReceivedMock).toHaveBeenCalledTimes(2);
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

  it('setupSecurity prod mode sets restrictive CSP', async () => {
    mockApp.isPackaged = true;
    isDevEnvMock.mockReturnValue(false);

    const { setupSecurity } = await import('../../main');
    setupSecurity();

    expect(onHeadersReceivedMock).toHaveBeenCalledTimes(2);
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

    mockBrowserWindowInstance.loadURL.mockResolvedValueOnce(undefined);

    const { createWindow } = await import('../../main');
    await createWindow();

    expect(mockBrowserWindowInstance.loadURL).toHaveBeenCalledTimes(1);
    expect(mockBrowserWindowInstance.loadURL).toHaveBeenCalledWith('http://localhost:8081');
    const attemptedUrls = mockBrowserWindowInstance.loadURL.mock.calls.map(
      (call: [string]) => call[0]
    );
    for (const url of attemptedUrls) {
      expect(url).toBe('http://localhost:8081');
    }
    expect(mockBrowserWindowInstance.webContents.openDevTools).not.toHaveBeenCalled();
  });

  it('createWindow dev mode opens dev tools only when explicitly enabled', async () => {
    mockApp.isPackaged = false;
    existsSyncMock.mockReturnValue(false);
    isDevEnvMock.mockReturnValue(false);
    process.env['CI'] = 'false';
    process.env['BRAINSTRIKE_DESKTOP_OPEN_DEVTOOLS'] = '1';
    mockBrowserWindowInstance.loadURL.mockResolvedValueOnce(undefined);

    const { createWindow } = await import('../../main');
    const win = await createWindow();

    expect(mockBrowserWindowInstance.loadURL).toHaveBeenCalledWith('http://localhost:8081');
    expect(mockBrowserWindowInstance.webContents.openDevTools).toHaveBeenCalled();
    // Vitest 4 constructor mocks return `this`, not the original mock object
    // Verify win has the expected mock functions attached
    expect(win.loadURL).toBeDefined();
    expect(win.loadFile).toBeDefined();
  });

  it('createWindow production loads renderer/index.html', async () => {
    mockApp.isPackaged = true;
    existsSyncMock.mockReturnValue(true);
    isDevEnvMock.mockReturnValue(false);

    const { createWindow } = await import('../../main');
    await createWindow();

    expect(mockBrowserWindowInstance.loadFile).toHaveBeenCalled();
    const arg = mockBrowserWindowInstance.loadFile.mock.calls[0]?.[0] as string;
    expect(arg).toContain('renderer/index.html');
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
