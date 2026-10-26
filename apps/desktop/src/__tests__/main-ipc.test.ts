import { describe, expect, it, vi } from 'vitest';
import { invokeDesktopIpc } from './helpers/desktop-ipc-sender-test-helpers';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const mockedFs = { ...actual, mkdirSync: vi.fn() };
  return { ...mockedFs, default: mockedFs };
});

const lifecycleHandlers = vi.hoisted(() => new Map<string, () => void>());

// Hoist the Electron mock to avoid factory/temporal dead zone issues
vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const electronStub = await vi.importActual<typeof import('./electron-test-stub.mts')>(
    './electron-test-stub.mts'
  );
  const app = {
    ...electronStub.app,
    ...electronUtils.createAppMock({
      documentsPath: '/mock/userData',
      whenReadyResolved: true,
    }),
  };
  app.on.mockImplementation((event: string, listener: () => void) => {
    lifecycleHandlers.set(event, listener);
    return app;
  });
  const ipcMain = electronUtils.createIpcMainMock();
  const screen = electronUtils.createScreenMock();
  const mockBrowserWindowInstance = {
    getBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
    getNormalBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    maximize: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    webContents: {
      on: vi.fn(),
      openDevTools: vi.fn(),
      setWindowOpenHandler: vi.fn(),
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
    ...electronStub,
    app,
    BrowserWindow,
    clipboard: {
      writeText: vi.fn(),
    },
    ipcMain,
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
    screen,
    session: {
      ...electronStub.session,
      defaultSession: { webRequest: { onHeadersReceived: vi.fn() } },
    },
    shell: {
      openPath: vi.fn().mockResolvedValue(''),
      showItemInFolder: vi.fn(),
    },
  };
});

// Import mocked Electron parts for use in assertions
import { ipcMain } from 'electron';

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
  it('returns the Electron profile path without constructing a PostgreSQL path', async () => {
    await expect(invokeDesktopIpc(ipcMain, 'db:getUserDataPath')).resolves.toBe('/mock/path');
  });

  it('stops serving MCP methods during will-quit shutdown', async () => {
    await Promise.resolve();
    const willQuitHandler = lifecycleHandlers.get('will-quit');
    if (typeof willQuitHandler !== 'function') {
      throw new Error('will-quit handler not registered');
    }

    willQuitHandler();

    await expect(invokeDesktopIpc(ipcMain, 'mcp:config:selectPath')).rejects.toThrow(
      'No desktop IPC handler for mcp:config:selectPath.'
    );
  });
});
