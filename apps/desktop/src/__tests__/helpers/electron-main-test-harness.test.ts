import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  electronMainMock,
  getRegisteredIpcMainHandler,
  getRegisteredIpcMainListener,
  resetElectronMainTestHarness,
  setMockWebContents,
} from './electron-main-test-harness';

const { default: electronTestStub } = await vi.importActual<
  typeof import('../electron-test-stub.mts')
>('../electron-test-stub.mts');

describe('electron main test harness', () => {
  beforeEach(() => {
    resetElectronMainTestHarness();
  });

  it('tracks registered handlers and listeners through cleanup', () => {
    const handler = vi.fn();
    const listener = vi.fn();

    electronMainMock.ipcMain.handle('test:handle', handler);
    electronMainMock.ipcMain.on('test:on', listener);

    expect(getRegisteredIpcMainHandler('test:handle')).toBe(handler);
    expect(getRegisteredIpcMainListener('test:on')).toBe(listener);

    electronMainMock.ipcMain.removeHandler('test:handle');
    electronMainMock.ipcMain.removeListener('test:on', listener);

    expect(() => getRegisteredIpcMainHandler('test:handle')).toThrow(
      'No ipcMain.handle registration found for channel: test:handle'
    );
    expect(() => getRegisteredIpcMainListener('test:on')).toThrow(
      'No ipcMain.on registration found for channel: test:on'
    );
  });

  it('owns and resets the shared WebContents listing', () => {
    const contents = { id: 42 };
    setMockWebContents([contents]);

    expect(electronMainMock.webContents.getAllWebContents()).toEqual([contents]);

    resetElectronMainTestHarness();

    expect(electronMainMock.webContents.getAllWebContents()).toEqual([]);
  });

  it('restores the owned WebContents implementation after a per-test override', () => {
    const staleContents = { id: 1 };
    const currentContents = { id: 2 };
    electronMainMock.webContents.getAllWebContents.mockReturnValue([staleContents]);

    resetElectronMainTestHarness();
    setMockWebContents([currentContents]);

    expect(electronMainMock.webContents.getAllWebContents()).toEqual([currentContents]);
    expect(electronMainMock.webContents.getAllWebContents()).not.toContain(staleContents);
  });

  it('fails visibly when a channel registers a second handler', () => {
    electronMainMock.ipcMain.handle('test:duplicate', vi.fn());

    expect(() => electronMainMock.ipcMain.handle('test:duplicate', vi.fn())).toThrow(
      "Attempted to register a second handler for 'test:duplicate'"
    );
  });

  it('models multiple listeners without silently selecting the latest one', () => {
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    electronMainMock.ipcMain.on('test:multiple', firstListener);
    electronMainMock.ipcMain.on('test:multiple', secondListener);

    expect(() => getRegisteredIpcMainListener('test:multiple')).toThrow(
      'Multiple ipcMain.on registrations found for channel: test:multiple'
    );

    electronMainMock.ipcMain.removeListener('test:multiple', firstListener);
    expect(getRegisteredIpcMainListener('test:multiple')).toBe(secondListener);
  });

  it('layers harness controls over the complete inert Electron test stub', () => {
    const harnessKeys = Object.keys(electronMainMock).filter((key) => key !== 'default');
    expect(harnessKeys.sort()).toEqual(Object.keys(electronTestStub).sort());
    expect(electronMainMock.default).toBe(electronMainMock);
    expect(electronMainMock.BrowserWindow.getAllWindows()).toEqual([]);
    expect(electronMainMock.webContents.fromId()).toBeNull();
  });
});
