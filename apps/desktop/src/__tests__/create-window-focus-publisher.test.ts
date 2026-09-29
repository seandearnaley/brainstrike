import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindow } from '../create-window';
import { configureDesktopRendererTarget } from '../desktop-renderer-target';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { TEST_DESKTOP_RENDERER_TARGET } from './helpers/desktop-ipc-sender-frame-test-allowlist';

const { existsSyncMock, MockBrowserWindow, screenMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  MockBrowserWindow: vi.fn(),
  screenMock: vi.fn(),
}));
vi.mock('node:fs', () => ({
  default: { existsSync: existsSyncMock },
  existsSync: existsSyncMock,
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, on: vi.fn() },
  BrowserWindow: MockBrowserWindow,
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  screen: { getAllDisplays: screenMock },
}));

/**
 * BST-1864: the renderer subscribes to `window-focus:changed` and asks
 * `isFocused()` DURING the renderer load, and `show()` itself hands the window
 * key status. The publisher must therefore be attached by `createWindow`, before
 * `show()` and before the load starts: a listener attached after
 * `createWindow()` resolved misses any transition the renderer's initial read
 * predates, and `useAppActive()` stays stale until the next focus change.
 */
/** The runtime shape of a live BrowserWindow: `isDestroyed` answers and `send` works. */
function createWindowFake() {
  const webContents = {
    getURL: vi.fn(() => ''),
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    openDevTools: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  return {
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    maximize: vi.fn(),
    on: vi.fn<(event: string, listener: () => void) => void>(),
    once: vi.fn(),
    setTitle: vi.fn(),
    show: vi.fn(),
    webContents,
  };
}

describe('createWindow native focus publisher', () => {
  const FOCUS_CHANGED = DESKTOP_IPC_CHANNELS.windowFocus.changed;
  let fake: ReturnType<typeof createWindowFake>;

  /** Fires every listener `createWindow` registered for a native window event. */
  const emitWindowEvent = (event: 'blur' | 'focus'): void => {
    for (const [name, listener] of fake.on.mock.calls) {
      if (name === event) {
        listener();
      }
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(process.env, 'CI');
    existsSyncMock.mockReturnValue(true);
    Object.defineProperty(vi.mocked(app), 'isPackaged', { configurable: true, value: true });
    screenMock.mockReturnValue([{ workArea: { height: 900, width: 1440, x: 0, y: 0 } }]);
    fake = createWindowFake();
    MockBrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
      Object.assign(this, fake);
    });
  });

  afterEach(() => {
    configureDesktopRendererTarget(TEST_DESKTOP_RENDERER_TARGET);
  });

  it('publishes a native blur that lands while the renderer is still loading', async () => {
    let resolveLoad: (() => void) | undefined;
    fake.loadFile.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    const pending = createWindow();
    // The load is in flight: the renderer may already have subscribed and asked
    // `isFocused()`, so a transition now must reach it as a push.
    expect(fake.loadFile).toHaveBeenCalled();
    emitWindowEvent('blur');

    expect(fake.webContents.send).toHaveBeenCalledWith(FOCUS_CHANGED, false);

    resolveLoad?.();
    await pending;
  });

  it('publishes the focus that show() itself gives the window', async () => {
    // A shown window becomes key: the `focus` lands inside `show()`.
    fake.show.mockImplementation(() => {
      emitWindowEvent('focus');
    });

    await createWindow();

    expect(fake.show).toHaveBeenCalledTimes(1);
    expect(fake.webContents.send).toHaveBeenCalledWith(FOCUS_CHANGED, true);
  });

  it('drops a blur that lands after the renderer is destroyed instead of throwing', async () => {
    await createWindow();
    // A window resigns key while it closes: a destroyed WebContents THROWS on `send`.
    fake.webContents.isDestroyed.mockReturnValue(true);
    fake.webContents.send.mockImplementation(() => {
      throw new TypeError('Object has been destroyed');
    });

    expect(() => {
      emitWindowEvent('blur');
    }).not.toThrow();
  });
});
