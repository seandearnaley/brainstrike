import path from 'node:path';
import type { createIpcMainMock, createIpcRendererMock } from '@brainstrike/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist the Electron mock to avoid factory/temporal dead zone issues
vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const app = electronUtils.createAppMock({
    whenReadyResolved: true,
    documentsPath: '/mock/userData',
  });
  const ipcMain = electronUtils.createIpcMainMock();
  Object.assign(ipcMain, {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  });
  const ipcRenderer = electronUtils.createIpcRendererMock();
  const screen = electronUtils.createScreenMock();
  // Wire renderer invokes to main handlers for convenience
  const mockInvoke = (ipcRenderer as unknown as ReturnType<typeof createIpcRendererMock>).invoke;
  mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) =>
    (ipcMain as unknown as ReturnType<typeof createIpcMainMock>).__invoke(channel, ...args)
  );
  const mockBrowserWindowInstance = {
    once: vi.fn(),
    on: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    maximize: vi.fn(),
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
  const BrowserWindow = vi.fn();
  BrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, mockBrowserWindowInstance);
  });
  Object.assign(BrowserWindow, {
    getAllWindows: vi.fn(() => []),
  });
  return {
    app,
    ipcMain,
    ipcRenderer,
    screen,
    BrowserWindow,
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
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
  };
});

// Import mocked Electron parts for use in assertions
import { app, ipcMain, ipcRenderer } from 'electron';

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

import '../main';

describe('db:getUserDataPath IPC handler', () => {
  beforeEach(() => {
    (ipcMain as unknown as ReturnType<typeof createIpcMainMock>).handle.mockClear();
    vi.mocked(ipcMain.removeHandler).mockClear();
    vi.mocked(ipcMain.removeListener).mockClear();
    (ipcRenderer as unknown as ReturnType<typeof createIpcRendererMock>).invoke.mockClear();
  });

  it('returns the user database path', async () => {
    // In test environment (NODE_ENV=test), we expect the isolated path structure
    // defined in db-main.ts: path.join(app.getPath('userData'), 'profiles', 'test', 'pgdata')
    // The default app mock returns '/mock/path' for 'userData'
    const expected = path.join('/mock/path', 'profiles', 'test', 'pgdata');
    const result = await ipcRenderer.invoke('db:getUserDataPath');
    expect(result).toBe(expected);
  });

  it('unregisters MCP IPC handlers during will-quit shutdown', async () => {
    await Promise.resolve();
    const willQuitHandler = vi
      .mocked(app.on)
      .mock.calls.find(([event]) => event === 'will-quit')?.[1];
    if (typeof willQuitHandler !== 'function') {
      throw new Error('will-quit handler not registered');
    }

    willQuitHandler();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith('mcp:config:get');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('mcp:tools:getStats');
  });
});
