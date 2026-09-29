import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecordingWindow,
  electronMainMock,
  getRegisteredIpcMainHandler,
  getRegisteredIpcMainListener,
  type RecordingWindow,
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

  it('resets mock functions attached to the BrowserWindow constructor', () => {
    electronMainMock.BrowserWindow.getAllWindows();
    electronMainMock.BrowserWindow.getAllWindows.mockImplementationOnce(() => {
      throw new Error('stale one-shot BrowserWindow implementation');
    });

    resetElectronMainTestHarness();

    expect(electronMainMock.BrowserWindow.getAllWindows).not.toHaveBeenCalled();
    expect(electronMainMock.BrowserWindow.getAllWindows()).toEqual([]);
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

  // BST-1622. The empty default is deliberate — most desktop tests never look
  // at renderer traffic — so it stays, and the tests that DO look opt into a
  // recording window rather than each hand-rolling
  // `{ isDestroyed: () => false, webContents: { send } }`.
  describe('createRecordingWindow', () => {
    it('records every send in order and reads them back per channel', () => {
      const window = createRecordingWindow();

      window.webContents.send('mcp:config:updated', { servers: [] });
      window.webContents.send('mcp:tools:updated', {});
      window.webContents.send('mcp:config:updated', { servers: ['linear'] });

      expect(window.events).toEqual([
        { channel: 'mcp:config:updated', payload: { servers: [] } },
        { channel: 'mcp:tools:updated', payload: {} },
        { channel: 'mcp:config:updated', payload: { servers: ['linear'] } },
      ]);
      expect(window.payloadsFor('mcp:config:updated')).toEqual([
        { servers: [] },
        { servers: ['linear'] },
      ]);
      expect(window.payloadsFor('mcp:status:updated')).toEqual([]);
    });

    it('exposes the same mock through `send` and `webContents.send`', () => {
      const window = createRecordingWindow();

      window.webContents.send('mcp:tools:updated', {});

      expect(window.send).toBe(window.webContents.send);
      expect(window.send).toHaveBeenCalledExactlyOnceWith('mcp:tools:updated', {});
    });

    it('is live in the listing the broadcast loops read', () => {
      const window = createRecordingWindow();
      const destroyed = createRecordingWindow({ destroyed: true });
      electronMainMock.BrowserWindow.getAllWindows.mockReturnValue([
        window,
        destroyed,
      ] as unknown as ReturnType<typeof electronMainMock.BrowserWindow.getAllWindows>);

      // The loop shape the getAllWindows()-ITERATING broadcasts run. Not
      // every listing-routed send is this shape — chunking-host-manager.ts
      // picks one window out of the listing with .find() rather than looping —
      // and terminal-ipc-handlers.ts never consults a listing at all
      // (BST-1624). An empty listing hollows out all three regardless.
      const listing =
        electronMainMock.BrowserWindow.getAllWindows() as unknown as RecordingWindow[];
      for (const listed of listing) {
        if (listed.isDestroyed()) {
          continue;
        }
        listed.webContents.send('mcp:status:updated', { state: 'connected' });
      }

      expect(destroyed.events).toEqual([]);

      expect(window.events).toEqual([
        { channel: 'mcp:status:updated', payload: { state: 'connected' } },
      ]);
    });

    it('models a destroyed window so `isDestroyed()` skips still work', () => {
      const window = createRecordingWindow({ destroyed: true });

      expect(window.isDestroyed()).toBe(true);
      expect(window.webContents.isDestroyed()).toBe(true);
    });

    it('gives distinct ids by default and honours explicit ones', () => {
      const first = createRecordingWindow();
      const second = createRecordingWindow();
      const pinned = createRecordingWindow({ id: 4242, webContentsId: 99 });

      expect(first.id).not.toBe(second.id);
      expect(first.webContents.id).toBe(first.id);
      expect(pinned.id).toBe(4242);
      expect(pinned.webContents.id).toBe(99);
    });

    // `events` and `send.mock.calls` are two views of the same traffic, so a
    // reset that clears one alone leaves a window answering
    // `toHaveBeenCalledTimes` and `payloadsFor` differently.
    it('reset() clears both the events log and the mock call log', () => {
      const window = createRecordingWindow();
      window.webContents.send('mcp:tools:updated', {});

      window.reset();

      expect(window.events).toEqual([]);
      expect(window.send).not.toHaveBeenCalled();
      expect(window.payloadsFor('mcp:tools:updated')).toEqual([]);
    });

    it('reset() clears in place, so an alias taken earlier stays live', () => {
      const window = createRecordingWindow();
      const events = window.events;
      window.webContents.send('a', 1);

      window.reset();
      window.webContents.send('b', 2);

      expect(events).toEqual([{ channel: 'b', payload: 2 }]);
      expect(window.send).toHaveBeenCalledExactlyOnceWith('b', 2);
    });

    it('keeps each window’s recording independent', () => {
      const first = createRecordingWindow();
      const second = createRecordingWindow();

      first.webContents.send('a', 1);

      expect(first.events).toHaveLength(1);
      expect(second.events).toEqual([]);
    });
  });
});
