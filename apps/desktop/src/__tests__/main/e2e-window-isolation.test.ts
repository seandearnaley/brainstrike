import path from 'node:path';
import type { createAppMock } from '@brainstrike/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, default: { ...fs, mkdirSync: vi.fn() } };
});

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
    documentsPath: '/mock/userData',
    whenReadyResolved: true,
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
    clipboard: {
      writeText: vi.fn(),
    },
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(),
    },
    ipcMain,
    Menu: {
      buildFromTemplate: vi.fn(),
      setApplicationMenu: vi.fn(),
    },
    powerMonitor: {
      on: vi.fn(),
    },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
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

vi.mock('../../create-window', () => ({
  createWindow: vi.fn(async () => ({
    getBounds: vi.fn(() => ({ height: 800, width: 1280, x: 0, y: 0 })),
    getNormalBounds: vi.fn(() => ({ height: 800, width: 1280, x: 0, y: 0 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    on: vi.fn(),
    webContents: {
      reloadIgnoringCache: vi.fn(),
      send: vi.fn(),
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
const ORIGINAL_AGENT_DEVTOOLS = process.env['BRAINSTRIKE_AGENT_DEVTOOLS'];
const ORIGINAL_ELECTRON_E2E = process.env['ELECTRON_IS_E2E_TEST'];
const ORIGINAL_E2E_USER_DATA_DIR = process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'];

describe('main E2E window isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ORIGINAL_ARGV.filter((arg) => arg !== '--test-mode');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_AGENT_DEVTOOLS');
    Reflect.deleteProperty(process.env, 'ELECTRON_IS_E2E_TEST');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_E2E_USER_DATA_DIR');
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    if (ORIGINAL_AGENT_DEVTOOLS === undefined) {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_AGENT_DEVTOOLS');
    } else {
      process.env['BRAINSTRIKE_AGENT_DEVTOOLS'] = ORIGINAL_AGENT_DEVTOOLS;
    }
    if (ORIGINAL_ELECTRON_E2E === undefined) {
      Reflect.deleteProperty(process.env, 'ELECTRON_IS_E2E_TEST');
    } else {
      process.env['ELECTRON_IS_E2E_TEST'] = ORIGINAL_ELECTRON_E2E;
    }
    if (ORIGINAL_E2E_USER_DATA_DIR === undefined) {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_E2E_USER_DATA_DIR');
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
    if (!mockedApp) {
      throw new Error('expected Electron app mock');
    }
    expect(mockedApp.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(mockedApp.on).not.toHaveBeenCalledWith('second-instance', expect.any(Function));

    if (process.platform === 'darwin') {
      expect(mockedApp.setActivationPolicy).toHaveBeenCalledWith('accessory');
      expect(mockedApp.dock?.hide).toHaveBeenCalledTimes(1);
    }
  });

  it('overrides Electron userData, sessionData, and logs paths during desktop E2E launches', async () => {
    process.argv = [...process.argv, '--test-mode'];
    process.env['ELECTRON_IS_E2E_TEST'] = 'true';
    process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'] = '/tmp/brainstrike-e2e-isolated-profile';

    await import('../../main');
    await Promise.resolve();

    const mockedApp = electronMockState.app;

    expect(mockedApp).not.toBeNull();
    if (!mockedApp) {
      throw new Error('expected Electron app mock');
    }
    expect(mockedApp.setPath).toHaveBeenCalledWith(
      'userData',
      '/tmp/brainstrike-e2e-isolated-profile'
    );
    expect(mockedApp.setPath).toHaveBeenCalledWith(
      'sessionData',
      path.join('/tmp/brainstrike-e2e-isolated-profile', 'session-data')
    );
    expect(mockedApp.setPath).toHaveBeenCalledWith(
      'logs',
      path.join('/tmp/brainstrike-e2e-isolated-profile', 'logs')
    );
  });

  it('isolates Agent DevTools paths without enabling E2E runtime semantics', async () => {
    process.env['BRAINSTRIKE_AGENT_DEVTOOLS'] = '1';
    process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'] = '/tmp/brainstrike-agent-isolated-profile';

    await import('../../main');
    await Promise.resolve();

    const mockedApp = electronMockState.app;

    expect(mockedApp).not.toBeNull();
    if (!mockedApp) {
      throw new Error('expected Electron app mock');
    }
    expect(mockedApp.setPath).toHaveBeenCalledWith(
      'userData',
      '/tmp/brainstrike-agent-isolated-profile'
    );
    expect(mockedApp.setPath).toHaveBeenCalledWith(
      'sessionData',
      path.join('/tmp/brainstrike-agent-isolated-profile', 'session-data')
    );
    expect(mockedApp.setPath).toHaveBeenCalledWith(
      'logs',
      path.join('/tmp/brainstrike-agent-isolated-profile', 'logs')
    );
    expect(mockedApp.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Agent DevTools has no isolated profile path', async () => {
    process.env['BRAINSTRIKE_AGENT_DEVTOOLS'] = '1';

    await expect(import('../../main')).rejects.toThrow(
      'BRAINSTRIKE_E2E_USER_DATA_DIR is required when Agent DevTools is enabled.'
    );
  });

  it('keeps single-instance protection enabled outside desktop E2E launches', async () => {
    await import('../../main');
    await Promise.resolve();

    const mockedApp = electronMockState.app;

    expect(mockedApp).not.toBeNull();
    if (!mockedApp) {
      throw new Error('expected Electron app mock');
    }
    expect(mockedApp.requestSingleInstanceLock).toHaveBeenCalled();
    expect(mockedApp.on).toHaveBeenCalledWith('second-instance', expect.any(Function));
  });
});
