import type { createAppMock } from '@brainstrike/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMockState = vi.hoisted(() => ({
  app: null as
    | (ReturnType<typeof createAppMock> & {
        dock?: { hide: ReturnType<typeof vi.fn> };
        requestSingleInstanceLock?: ReturnType<typeof vi.fn>;
        setActivationPolicy?: ReturnType<typeof vi.fn>;
      })
    | null,
}));

vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const app = electronUtils.createAppMock({
    whenReadyResolved: true,
    documentsPath: '/mock/userData',
  });
  Object.assign(app, {
    dock: { hide: vi.fn() },
    requestSingleInstanceLock: vi.fn(() => true),
    setActivationPolicy: vi.fn(),
  });
  electronMockState.app = app as ReturnType<typeof createAppMock> & {
    dock?: { hide: ReturnType<typeof vi.fn> };
    requestSingleInstanceLock?: ReturnType<typeof vi.fn>;
    setActivationPolicy?: ReturnType<typeof vi.fn>;
  };

  const ipcMain = electronUtils.createIpcMainMock();
  Object.assign(ipcMain, {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  });

  const BrowserWindow = vi.fn();
  Object.assign(BrowserWindow, {
    getAllWindows: vi.fn(() => []),
  });

  return {
    app,
    BrowserWindow,
    Menu: {
      buildFromTemplate: vi.fn(),
      setApplicationMenu: vi.fn(),
    },
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(),
    },
    ipcMain,
    powerMonitor: {
      on: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(),
    },
  };
});

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

vi.mock('../../assistant-server', () => ({
  startAssistantServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:0',
    stop: vi.fn(),
  })),
}));

vi.mock('../../create-window', () => ({
  createWindow: vi.fn(async () => ({
    on: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 800 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 800 })),
    webContents: {
      send: vi.fn(),
      reloadIgnoringCache: vi.fn(),
    },
  })),
  noteNextWindowReload: vi.fn(),
}));

vi.mock('../../window-state', () => ({
  readStoredWindowState: vi.fn(() => null),
  registerWindowStatePersistence: vi.fn(),
}));

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

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_ELECTRON_E2E = process.env['ELECTRON_IS_E2E_TEST'];
const ORIGINAL_E2E_USER_DATA_DIR = process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'];

describe('main E2E window isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ORIGINAL_ARGV.filter((arg) => arg !== '--test-mode');
    // biome-ignore lint/performance/noDelete: process.env coerces = undefined to the string "undefined"; delete is the only way to truly clear a key
    delete process.env['ELECTRON_IS_E2E_TEST'];
    // biome-ignore lint/performance/noDelete: process.env coerces = undefined to the string "undefined"; delete is the only way to truly clear a key
    delete process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'];
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    if (ORIGINAL_ELECTRON_E2E === undefined) {
      // biome-ignore lint/performance/noDelete: process.env coerces = undefined to the string "undefined"; delete is the only way to truly clear a key
      delete process.env['ELECTRON_IS_E2E_TEST'];
    } else {
      process.env['ELECTRON_IS_E2E_TEST'] = ORIGINAL_ELECTRON_E2E;
    }
    if (ORIGINAL_E2E_USER_DATA_DIR === undefined) {
      // biome-ignore lint/performance/noDelete: process.env coerces = undefined to the string "undefined"; delete is the only way to truly clear a key
      delete process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'];
    } else {
      process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'] = ORIGINAL_E2E_USER_DATA_DIR;
    }
  });

  it('skips single-instance focus behavior during desktop E2E launches', async () => {
    process.argv = [...process.argv, '--test-mode'];
    process.env['ELECTRON_IS_E2E_TEST'] = 'true';

    await import('../../main');
    await Promise.resolve();

    const mockedApp = electronMockState.app;

    expect(mockedApp).not.toBeNull();
    expect(mockedApp.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(mockedApp.on).not.toHaveBeenCalledWith('second-instance', expect.any(Function));

    if (process.platform === 'darwin') {
      expect(mockedApp.setActivationPolicy).toHaveBeenCalledWith('accessory');
      expect(mockedApp.dock?.hide).toHaveBeenCalledTimes(1);
    }
  });

  it('overrides Electron userData and sessionData paths during desktop E2E launches', async () => {
    process.argv = [...process.argv, '--test-mode'];
    process.env['ELECTRON_IS_E2E_TEST'] = 'true';
    process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'] = '/tmp/brainstrike-e2e-isolated-profile';

    await import('../../main');
    await Promise.resolve();

    const mockedApp = electronMockState.app;

    expect(mockedApp).not.toBeNull();
    expect(mockedApp.setPath).toHaveBeenCalledWith(
      'userData',
      '/tmp/brainstrike-e2e-isolated-profile'
    );
    expect(mockedApp.setPath).toHaveBeenCalledWith(
      'sessionData',
      '/tmp/brainstrike-e2e-isolated-profile/session-data'
    );
  });

  it('keeps single-instance protection enabled outside desktop E2E launches', async () => {
    await import('../../main');
    await Promise.resolve();

    const mockedApp = electronMockState.app;

    expect(mockedApp).not.toBeNull();
    expect(mockedApp.requestSingleInstanceLock).toHaveBeenCalled();
    expect(mockedApp.on).toHaveBeenCalledWith('second-instance', expect.any(Function));
  });
});
