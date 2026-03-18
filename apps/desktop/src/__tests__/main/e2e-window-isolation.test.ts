import type { createAppMock } from '@brainstrike/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('main E2E window isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    process.argv = ORIGINAL_ARGV.filter((arg) => arg !== '--test-mode');
    // biome-ignore lint/performance/noDelete: process.env coerces = undefined to the string "undefined"; delete is the only way to truly clear a key
    delete process.env['ELECTRON_IS_E2E_TEST'];
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    if (ORIGINAL_ELECTRON_E2E === undefined) {
      // biome-ignore lint/performance/noDelete: process.env coerces = undefined to the string "undefined"; delete is the only way to truly clear a key
      delete process.env['ELECTRON_IS_E2E_TEST'];
    } else {
      process.env['ELECTRON_IS_E2E_TEST'] = ORIGINAL_ELECTRON_E2E;
    }
  });

  it('skips single-instance focus behavior during desktop E2E launches', async () => {
    process.argv = [...process.argv, '--test-mode'];
    process.env['ELECTRON_IS_E2E_TEST'] = 'true';

    await import('../../main');
    await Promise.resolve();

    const { app } = await import('electron');
    const mockedApp = app as unknown as ReturnType<typeof createAppMock> & {
      dock?: { hide: ReturnType<typeof vi.fn> };
      requestSingleInstanceLock?: ReturnType<typeof vi.fn>;
      setActivationPolicy?: ReturnType<typeof vi.fn>;
    };

    expect(mockedApp.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(mockedApp.on).not.toHaveBeenCalledWith('second-instance', expect.any(Function));

    if (process.platform === 'darwin') {
      expect(mockedApp.setActivationPolicy).toHaveBeenCalledWith('accessory');
      expect(mockedApp.dock?.hide).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps single-instance protection enabled outside desktop E2E launches', async () => {
    await import('../../main');
    await Promise.resolve();

    const { app } = await import('electron');
    const mockedApp = app as unknown as ReturnType<typeof createAppMock> & {
      requestSingleInstanceLock?: ReturnType<typeof vi.fn>;
    };

    expect(mockedApp.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(mockedApp.on).toHaveBeenCalledWith('second-instance', expect.any(Function));
  });
});
