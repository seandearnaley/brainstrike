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
  webContents: {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    openDevTools: vi.fn(),
  },
  once: vi.fn((event: string, handler: () => void) => {
    if (event === 'ready-to-show') handler();
  }),
  show: vi.fn(),
};

const mockBrowserWindow = vi.fn(() => mockBrowserWindowInstance);

const whenReadyMock = vi.fn(() => Promise.resolve());

const mockApp = {
  isPackaged: false,
  whenReady: whenReadyMock,
  on: vi.fn(),
  getPath: vi.fn(),
  quit: vi.fn(),
};

vi.mock('electron', () => ({
  BrowserWindow: mockBrowserWindow,
  session: mockSession,
  app: mockApp,
  ipcMain: { handle: vi.fn() },
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', () => ({ default: { existsSync: existsSyncMock } }));

const isDevEnvMock = vi.fn();
const createLoggerMock = vi.fn(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@brainstrike/utils', () => ({
  isDevEnv: isDevEnvMock,
  createLogger: createLoggerMock,
}));
vi.mock('electron-store', () => ({ default: vi.fn(() => ({})) }));

describe('window setup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('setupSecurity dev mode sets dev CSP and logs when isDevEnv is true', async () => {
    mockApp.isPackaged = false;
    isDevEnvMock.mockReturnValue(true);

    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const { setupSecurity } = await import('../../main');
    setupSecurity();

    expect(onHeadersReceivedMock).toHaveBeenCalledTimes(1);
    const handler = onHeadersReceivedMock.mock.calls[0]?.[0] as (
      details: { responseHeaders?: Record<string, string[]> },
      callback: (r: { responseHeaders: Record<string, string[]> }) => void
    ) => void;
    const cb = vi.fn();
    handler?.({ responseHeaders: {} }, cb);
    expect(cb.mock.calls[0]?.[0].responseHeaders['Content-Security-Policy'][0]).toContain(
      'localhost:*'
    );
    expect(consoleSpy).toHaveBeenCalledWith('🔒 Development CSP configured:', expect.any(String));
    consoleSpy.mockRestore();
  });

  it('setupSecurity prod mode sets restrictive CSP', async () => {
    mockApp.isPackaged = true;
    isDevEnvMock.mockReturnValue(false);

    const { setupSecurity } = await import('../../main');
    setupSecurity();

    expect(onHeadersReceivedMock).toHaveBeenCalledTimes(1);
    const handler = onHeadersReceivedMock.mock.calls[0]?.[0] as (
      details: { responseHeaders?: Record<string, string[]> },
      callback: (r: { responseHeaders: Record<string, string[]> }) => void
    ) => void;
    const cb = vi.fn();
    handler?.({ responseHeaders: {} }, cb);
    const csp = cb.mock.calls[0]?.[0].responseHeaders['Content-Security-Policy'][0];
    expect(csp).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
  });

  it('createWindow dev mode tries ports sequentially and opens dev tools', async () => {
    mockApp.isPackaged = false;
    existsSyncMock.mockReturnValue(false);
    isDevEnvMock.mockReturnValue(false);

    mockBrowserWindowInstance.loadURL
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValueOnce(undefined);

    const { createWindow } = await import('../../main');
    const win = await createWindow();

    expect(mockBrowserWindowInstance.loadURL).toHaveBeenCalledWith('http://localhost:8081');
    expect(mockBrowserWindowInstance.loadURL).toHaveBeenCalledWith('http://localhost:8082');
    expect(mockBrowserWindowInstance.webContents.openDevTools).toHaveBeenCalled();
    expect(win).toBe(mockBrowserWindowInstance);
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
});
