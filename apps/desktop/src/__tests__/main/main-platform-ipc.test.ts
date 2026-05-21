import { BrowserWindow, ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMainPlatformIpcHandlers } from '../../main-platform-ipc';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

describe('main platform IPC', () => {
  let handlers: Map<string, RegisteredHandler>;
  let noteNextWindowReload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    noteNextWindowReload = vi.fn();

    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as RegisteredHandler);
    });
  });

  it('registers assistant URL and reload intent channels through the typed registry', () => {
    registerMainPlatformIpcHandlers({
      getAssistantUrl: () => 'http://127.0.0.1:4999',
      noteNextWindowReload,
    });

    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:get-url', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(
      'app:lifecycle:note-reload-intent',
      expect.any(Function)
    );
  });

  it('returns the current assistant URL from the injected getter', async () => {
    registerMainPlatformIpcHandlers({
      getAssistantUrl: () => 'http://127.0.0.1:4999',
      noteNextWindowReload,
    });

    expect(handlers.get('assistant:get-url')?.({})).toBe('http://127.0.0.1:4999');
  });

  it('records normalized renderer reload intent for the sender window', async () => {
    const window = { isDestroyed: () => false };
    const sender = {};
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as BrowserWindow);

    registerMainPlatformIpcHandlers({
      getAssistantUrl: () => '',
      noteNextWindowReload,
    });

    await handlers.get('app:lifecycle:note-reload-intent')?.({ sender }, ' factory-reset ');

    expect(noteNextWindowReload).toHaveBeenCalledWith(window, {
      reason: 'factory-reset',
      source: 'renderer',
    });
  });

  it('rejects empty reload intent reasons', async () => {
    registerMainPlatformIpcHandlers({
      getAssistantUrl: () => '',
      noteNextWindowReload,
    });

    await expect(
      handlers.get('app:lifecycle:note-reload-intent')?.({ sender: {} }, '   ')
    ).rejects.toThrow('Renderer reload intent reason must be a non-empty string.');
  });

  it('rejects reload intent from a destroyed sender window', async () => {
    const window = { isDestroyed: () => true };
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as BrowserWindow);

    registerMainPlatformIpcHandlers({
      getAssistantUrl: () => '',
      noteNextWindowReload,
    });

    await expect(
      handlers.get('app:lifecycle:note-reload-intent')?.({ sender: {} }, 'factory-reset')
    ).rejects.toThrow('Renderer reload intent must originate from a live BrowserWindow.');
  });

  it('unregisters both channels', () => {
    const unregister = registerMainPlatformIpcHandlers({
      getAssistantUrl: () => '',
      noteNextWindowReload,
    });

    unregister();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith('assistant:get-url');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('app:lifecycle:note-reload-intent');
  });
});
