import type { createIpcMainMock, createIpcRendererMock } from '@brainstrike/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const statSync = vi.fn(() => ({ isDirectory: () => true }));
  const statAsync = vi.fn(async () => ({
    isDirectory: () => true,
    size: 128,
    mtimeMs: Date.now(),
  }));
  const accessAsync = vi.fn(async () => undefined);

  const mockedFs = {
    ...actual,
    statSync,
    promises: {
      ...actual.promises,
      access: accessAsync,
      stat: statAsync,
    },
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
    whenReadyResolved: true,
    documentsPath: '/mock/userData',
  });
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
      getAllWebContents: vi.fn(() => []),
      getType: vi.fn(() => 'window'),
      send: vi.fn(),
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
    ipcMain,
    ipcRenderer,
    screen,
    BrowserWindow,
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn(),
    },
    dialog: {
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
      showErrorBox: vi.fn(),
    },
    shell: {
      showItemInFolder: vi.fn(),
    },
    webContents: {
      getAllWebContents: vi.fn(() => []),
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

import fs from 'node:fs'; // Import mocked fs
import type { LoggingPreferences } from '@brainstrike/utils';
import { LogLevel } from '@brainstrike/utils';
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

vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual('@brainstrike/utils');
  return {
    ...actual,
    initializeLogging: vi.fn(),
    createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
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
      level: LogLevel.INFO,
      consoleEnabled: true,
      consoleLevel: LogLevel.INFO,
      includeTimestamp: true,
      redactPaths: [],
      file: {
        enabled: true,
        destination: '/mock/userData/logs/test.log',
        level: LogLevel.DEBUG,
        append: true,
        mkdir: true,
      },
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
        size: 100,
        mtimeMs: 1000,
      } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>)
      .mockResolvedValueOnce({
        isDirectory: () => true,
        size: 220,
        mtimeMs: 2000,
      } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>);

    const newPreferences: LoggingPreferences = {
      level: LogLevel.INFO,
      consoleEnabled: true,
      consoleLevel: LogLevel.INFO,
      includeTimestamp: true,
      redactPaths: [],
      file: {
        enabled: true,
        destination: '/mock/userData/logs/test.log',
        level: LogLevel.DEBUG,
        append: true,
        mkdir: true,
      },
    };

    await ipcRenderer.invoke('logging:set-preferences', newPreferences);

    const statTargets = statMock.mock.calls.map(([target]) => target);

    expect(statTargets[0]).toBe('/mock/userData/logs');
    expect(statTargets).toContain('/mock/userData/logs/test.log');
  });
});
