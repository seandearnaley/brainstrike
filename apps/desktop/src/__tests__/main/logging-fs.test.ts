import type { createIpcMainMock, createIpcRendererMock } from '@brainstrike/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const statSync = vi.fn(() => ({ isDirectory: () => true }));
  const statAsync = vi.fn(async () => ({
    isDirectory: () => true,
    mtimeMs: Date.now(),
    size: 128,
  }));
  const accessAsync = vi.fn(async () => undefined);

  const mockedFs = {
    ...actual,
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      access: accessAsync,
      stat: statAsync,
    },
    statSync,
  };
  return {
    ...mockedFs,
    default: mockedFs,
  };
});

// Hoist the Electron mock
vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const app = electronUtils.createAppMock({
    documentsPath: '/mock/userData',
    whenReadyResolved: true,
  });
  Object.assign(app, { requestSingleInstanceLock: vi.fn(() => true) });
  const ipcMain = electronUtils.createIpcMainMock();
  Object.assign(ipcMain, {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  });
  const ipcRenderer = electronUtils.createIpcRendererMock();
  const screen = electronUtils.createScreenMock();
  // Wire renderer invokes to main handlers
  const mockInvoke = (ipcRenderer as unknown as ReturnType<typeof createIpcRendererMock>).invoke;
  mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) =>
    (ipcMain as unknown as ReturnType<typeof createIpcMainMock>).__invoke(channel, ...args)
  );
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
      getAllWebContents: vi.fn(() => []),
      getType: vi.fn(() => 'window'),
      on: vi.fn(),
      openDevTools: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
  const BrowserWindow = vi.fn();
  BrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, mockBrowserWindowInstance);
    (BrowserWindow as any).getAllWindows = () => [];
  });
  (BrowserWindow as any).getAllWindows = () => [];

  return {
    app,
    BrowserWindow,
    clipboard: {
      writeText: vi.fn(),
    },
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    ipcMain,
    ipcRenderer,
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
      defaultSession: {
        on: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onHeadersReceived: vi.fn() },
      },
    },
    shell: {
      showItemInFolder: vi.fn(),
    },
    webContents: {
      getAllWebContents: vi.fn(() => []),
    },
  };
});

import fs from 'node:fs'; // Import mocked fs
import path from 'node:path';
import type { LoggingPreferences } from '@brainstrike/logging';
import { LogLevel } from '@brainstrike/logging';
import { ipcRenderer } from 'electron';

// Mock other dependencies
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

vi.mock('electron-store', () => {
  const MockElectronStore = vi.fn();
  MockElectronStore.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {
      get: vi.fn(),
      set: vi.fn(),
    });
  });
  return { default: MockElectronStore };
});

vi.mock('@brainstrike/logging', async () => {
  const actual = await vi.importActual('@brainstrike/logging');
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    initializeLogging: vi.fn(),
  };
});

// Import main to register handlers
import '../../main';

describe('logging IPC handler performance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup defaults if needed (mocks are cleared)
    // Actually mockClear clears usage data, not implementation if we defined it in factory.
    // But since we used vi.fn() inside factory, we might not have reference to them unless we spy again or trust fs import.

    // However, clearAllMocks() clears the history.
    // The implementation provided in factory persists unless we override it.
  });

  it('uses asynchronous fs.promises.stat (Optimized)', async () => {
    const newPreferences: LoggingPreferences = {
      consoleEnabled: true,
      consoleLevel: LogLevel.INFO,
      file: {
        append: true,
        destination: '/mock/userData/logs/test.log',
        enabled: true,
        level: LogLevel.DEBUG,
        mkdir: true,
      },
      includeTimestamp: true,
      level: LogLevel.INFO,
      redactPaths: [],
    };

    // We need to spy on the imported fs methods to verify calls
    // Since we mocked them with vi.fn(), we can just inspect them.

    await ipcRenderer.invoke('logging:set-preferences', newPreferences);

    // Optimized assertion: verify that Sync version is NOT called
    expect(fs.statSync).not.toHaveBeenCalled();
    // Async version SHOULD be called
    expect(fs.promises.stat).toHaveBeenCalled();
  });

  it('checks the destination directory asynchronously before verifying the log file', async () => {
    const statMock = vi.mocked(fs.promises.stat);
    statMock
      .mockResolvedValueOnce({
        isDirectory: () => true,
        mtimeMs: 1000,
        size: 100,
      } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>)
      .mockResolvedValueOnce({
        isDirectory: () => true,
        mtimeMs: 2000,
        size: 220,
      } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>);

    const newPreferences: LoggingPreferences = {
      consoleEnabled: true,
      consoleLevel: LogLevel.INFO,
      file: {
        append: true,
        destination: '/mock/userData/logs/test.log',
        enabled: true,
        level: LogLevel.DEBUG,
        mkdir: true,
      },
      includeTimestamp: true,
      level: LogLevel.INFO,
      redactPaths: [],
    };

    await ipcRenderer.invoke('logging:set-preferences', newPreferences);

    const statTargets = statMock.mock.calls.map(([target]) => target);

    expect(statTargets[0]).toBe(path.resolve('/mock/userData/logs'));
    expect(statTargets.some((target) => path.basename(String(target)) === 'test.log')).toBe(true);
  });
});
