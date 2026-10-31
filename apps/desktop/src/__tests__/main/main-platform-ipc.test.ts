import { BrowserWindow, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMainPlatformIpcHandlers } from '../../main-platform-ipc';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';
import { invokeDesktopIpcFrom } from '../helpers/desktop-ipc-sender-test-helpers';

const { isAppWindowSenderMock } = vi.hoisted(() => ({
  isAppWindowSenderMock: vi.fn(),
}));

type NoteNextWindowReload = NonNullable<
  Parameters<typeof registerMainPlatformIpcHandlers>[0]['noteNextWindowReload']
>;
type MainPlatformIpcDependencies = Parameters<typeof registerMainPlatformIpcHandlers>[0];

let unregister: (() => void) | undefined;

function registerPartialMainPlatformIpcHandlers(
  dependencies: Partial<MainPlatformIpcDependencies>
): () => void {
  unregister = registerMainPlatformIpcHandlers(
    dependencies as unknown as MainPlatformIpcDependencies
  );
  return unregister;
}

function invoke(event: unknown, method: string, ...args: unknown[]): Promise<unknown> {
  return invokeDesktopIpcFrom(ipcMain, event, method, ...args);
}

/** An app window's event; the reload-intent handler reads only its window. */
function appWindowEvent(sender: object = {}) {
  return { sender: { id: 100, ...sender }, senderFrame: createAllowlistedSenderFrame() };
}

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../app-windows', () => ({
  isAppWindowSender: isAppWindowSenderMock,
}));

describe('main platform IPC', () => {
  let noteNextWindowReload: ReturnType<typeof vi.fn<NoteNextWindowReload>>;

  beforeEach(() => {
    vi.clearAllMocks();
    noteNextWindowReload = vi.fn<NoteNextWindowReload>();
    isAppWindowSenderMock.mockReturnValue(true);
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it('records normalized renderer reload intent for the sender window', async () => {
    const window = { isDestroyed: () => false };
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as BrowserWindow);

    registerPartialMainPlatformIpcHandlers({
      noteNextWindowReload,
    });

    await invoke(appWindowEvent(), 'app:lifecycle:note-reload-intent', ' factory-reset ');

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
      invoke(appWindowEvent(), 'app:lifecycle:note-reload-intent', '   ')
    ).rejects.toThrow('invalid arguments');
  });

  it('rejects reload intent from a destroyed sender window', async () => {
    const window = { isDestroyed: () => true };
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as BrowserWindow);

    registerPartialMainPlatformIpcHandlers({
      noteNextWindowReload,
    });

    await expect(
      invoke(appWindowEvent(), 'app:lifecycle:note-reload-intent', 'factory-reset')
    ).rejects.toThrow('Renderer reload intent must originate from a live BrowserWindow.');
  });

  it('accepts a normalized reload request only from the current visible main frame', async () => {
    const window = { isDestroyed: () => false };
    const mainFrame = createAllowlistedSenderFrame();
    const sender = { id: 101, mainFrame };
    const requestReload = vi.fn();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as BrowserWindow);
    registerPartialMainPlatformIpcHandlers({ noteNextWindowReload, requestReload });
    await invoke(
      { sender, senderFrame: mainFrame },
      'app:lifecycle:request-reload',
      ' failed-chunk-recovery '
    );
    expect(requestReload).toHaveBeenCalledWith(window, 'failed-chunk-recovery');
    expect(noteNextWindowReload).not.toHaveBeenCalled();
  });

  it.each([
    'untracked sender',
    'untrusted URL',
    'subframe',
    'stale main frame',
    'empty reason',
    'destroyed window',
  ])('refuses a reload from %s before starting document retirement', async (control) => {
    const window = { isDestroyed: () => control === 'destroyed window' };
    const mainFrame = createAllowlistedSenderFrame();
    const sender = { id: 102, mainFrame };
    const senderFrame =
      control === 'untrusted URL'
        ? { url: 'https://untrusted.invalid/' }
        : control === 'subframe' || control === 'stale main frame'
          ? createAllowlistedSenderFrame()
          : mainFrame;
    if (control === 'untracked sender') {
      isAppWindowSenderMock.mockReturnValue(false);
    }
    const requestReload = vi.fn();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as BrowserWindow);
    registerPartialMainPlatformIpcHandlers({ noteNextWindowReload, requestReload });
    await expect(
      invoke(
        { sender, senderFrame },
        'app:lifecycle:request-reload',
        control === 'empty reason' ? ' ' : 'reload'
      )
    ).rejects.toThrow();
    expect(requestReload).not.toHaveBeenCalled();
  });

  it('stops serving its methods once unregistered', async () => {
    registerPartialMainPlatformIpcHandlers({ noteNextWindowReload })();

    for (const method of ['app:lifecycle:note-reload-intent', 'app:lifecycle:request-reload']) {
      await expect(invoke(appWindowEvent(), method, 'reload')).rejects.toThrow(
        `No desktop IPC handler for ${method}.`
      );
    }
    expect(noteNextWindowReload).not.toHaveBeenCalled();
  });
});
