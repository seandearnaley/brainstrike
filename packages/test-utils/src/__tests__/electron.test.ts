import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAppMock,
  createContextBridgeMock,
  createIpcMainMock,
  createIpcRendererMock,
  installElectronCjsMocks,
  installElectronModuleMocks,
} from '../electron';

describe('electron test utilities', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('creates ipcMain mock that registers and invokes handlers', async () => {
    const ipcMain = createIpcMainMock();
    const handler = vi.fn(async (_event, payload: string) => `echo:${payload}`);

    ipcMain.handle('channel', handler);
    await expect(ipcMain.__invoke('channel', 'input')).resolves.toBe('echo:input');
    expect(handler).toHaveBeenCalledWith({}, 'input');

    ipcMain.removeHandler('channel');
    await expect(ipcMain.__invoke('channel')).rejects.toThrow(/No handler/);
  });

  it('provides ipcRenderer, contextBridge and app mocks', async () => {
    const ipcRenderer = createIpcRendererMock();
    await expect(ipcRenderer.invoke('noop')).resolves.toBeUndefined();

    const contextBridge = createContextBridgeMock();
    expect(contextBridge.exposeInMainWorld).toBeTypeOf('function');

    const app = createAppMock({ documentsPath: '/docs', whenReadyResolved: false });
    expect(app.getPath('documents')).toBe('/docs');
    expect(app.whenReady()).toBeInstanceOf(Promise);
  });

  it('installs virtual electron module mocks for runtime require', () => {
    const parts = installElectronModuleMocks();
    expect(typeof parts.app.whenReady).toBe('function');
    expect(parts.ipcMain.handle).toBeTypeOf('function');
    expect(parts.ipcRenderer.invoke).toBeTypeOf('function');
    expect(parts.contextBridge.exposeInMainWorld).toBeTypeOf('function');
  });

  it('patches Module._load for CommonJS require and restores it', () => {
    const { restore, app } = installElectronCjsMocks();
    const Module = require('node:module');
    const req = Module.createRequire(import.meta.url);

    const electron = req('electron');
    expect(electron.app).toBe(app);

    const cacheKey = req.resolve('electron');
    delete req.cache?.[cacheKey];
    expect(() => restore()).not.toThrow();
  });
});
