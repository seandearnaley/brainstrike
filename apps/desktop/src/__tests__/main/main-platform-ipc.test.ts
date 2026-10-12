import { BrowserWindow, ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMainPlatformIpcHandlers } from '../../main-platform-ipc';

const { getWindowRoleByWebContentsIdMock } = vi.hoisted(() => ({
  getWindowRoleByWebContentsIdMock: vi.fn(),
}));

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type NoteNextWindowReload = NonNullable<
  Parameters<typeof registerMainPlatformIpcHandlers>[0]['noteNextWindowReload']
>;
type MainPlatformIpcDependencies = Parameters<typeof registerMainPlatformIpcHandlers>[0];

function registerPartialMainPlatformIpcHandlers(
  dependencies: Partial<MainPlatformIpcDependencies>
): () => void {
  return registerMainPlatformIpcHandlers(dependencies as unknown as MainPlatformIpcDependencies);
}

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

vi.mock('../../window-role', () => ({
  getWindowRoleByWebContentsId: getWindowRoleByWebContentsIdMock,
}));

describe('main platform IPC', () => {
  let handlers: Map<string, RegisteredHandler>;
  let noteNextWindowReload: ReturnType<typeof vi.fn<NoteNextWindowReload>>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    noteNextWindowReload = vi.fn<NoteNextWindowReload>();
    getWindowRoleByWebContentsIdMock.mockReturnValue('visible-ui');

    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as RegisteredHandler);
    });
  });

  it('registers the reload intent channel through the typed registry', () => {
    registerPartialMainPlatformIpcHandlers({ noteNextWindowReload });

    expect(ipcMain.handle).toHaveBeenCalledWith(
      'app:lifecycle:note-reload-intent',
      expect.any(Function)
    );
  });

  it('records normalized renderer reload intent for the sender window', async () => {
    const window = { isDestroyed: () => false };
    const sender = {};
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as BrowserWindow);

    registerPartialMainPlatformIpcHandlers({
      noteNextWindowReload,
    });

    await handlers.get('app:lifecycle:note-reload-intent')?.({ sender }, ' factory-reset ');

    expect(noteNextWindowReload).toHaveBeenCalledWith(window, {
      reason: 'factory-reset',
      source: 'renderer',
    });
  });

  it('rejects empty reload intent reasons', async () => {
    registerPartialMainPlatformIpcHandlers({
      noteNextWindowReload,
    });

    await expect(
      handlers.get('app:lifecycle:note-reload-intent')?.({ sender: {} }, '   ')
    ).rejects.toThrow('Renderer reload intent reason must be a non-empty string.');
  });

  it('rejects reload intent from a destroyed sender window', async () => {
    const window = { isDestroyed: () => true };
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as BrowserWindow);

    registerPartialMainPlatformIpcHandlers({
      noteNextWindowReload,
    });

    await expect(
      handlers.get('app:lifecycle:note-reload-intent')?.({ sender: {} }, 'factory-reset')
    ).rejects.toThrow('Renderer reload intent must originate from a live BrowserWindow.');
  });

  it('unregisters its channels', () => {
    const unregister = registerPartialMainPlatformIpcHandlers({
      noteNextWindowReload,
    });

    unregister();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith('app:lifecycle:note-reload-intent');
  });
});
