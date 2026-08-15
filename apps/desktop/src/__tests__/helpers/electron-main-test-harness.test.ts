import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  electronMainMock,
  getRegisteredIpcMainHandler,
  getRegisteredIpcMainListener,
  resetElectronMainTestHarness,
  setMockWebContents,
} from './electron-main-test-harness';

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
});
