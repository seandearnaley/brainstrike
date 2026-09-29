import { BrowserWindow, type BrowserWindow as ElectronBrowserWindow, ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishWindowFocus, registerWindowFocusIpcHandlers } from '../../window-focus-ipc';
import { clearWindowRoleByWebContentsId } from '../../window-role';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
} from '../helpers/desktop-ipc-sender-test-helpers';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

/**
 * BST-1864: main publishes the host BrowserWindow's native focus to its own
 * renderer. Verified in Electron 44 (probe recorded in
 * docs/agents/assistant-persistence/thread-groups-and-folders.md): focusing a
 * child `WebContentsView` or docked DevTools emits no `blur` on the window and
 * `isFocused()` stays true, so `focus`/`blur` here IS the OS window's focus.
 */
type WindowListener = () => void;

/**
 * A BrowserWindow double with the RUNTIME behaviour of a destroyed Electron
 * object: once destroyed, the `webContents` getter and `send` THROW (they do
 * not return undefined), while `isDestroyed()` keeps answering.
 */
class FakeBrowserWindow {
  private destroyed = false;
  private focused: boolean;
  private readonly listeners = new Map<string, WindowListener[]>();
  readonly sent: Array<{ readonly args: readonly unknown[]; readonly channel: string }> = [];
  private readonly contents: { isDestroyed: () => boolean; send: (...a: unknown[]) => void };

  constructor(focused: boolean) {
    this.focused = focused;
    this.contents = {
      isDestroyed: () => this.destroyed,
      send: (channel: unknown, ...args: unknown[]) => {
        if (this.destroyed) {
          throw new TypeError('Object has been destroyed');
        }
        this.sent.push({ args, channel: String(channel) });
      },
    };
  }

  get webContents() {
    if (this.destroyed) {
      throw new TypeError('Object has been destroyed');
    }
    return this.contents;
  }

  on(event: string, listener: WindowListener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFocused(): boolean {
    if (this.destroyed) {
      throw new TypeError('Object has been destroyed');
    }
    return this.focused;
  }

  emit(event: 'blur' | 'focus'): void {
    this.focused = event === 'focus';
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  destroy(): void {
    this.destroyed = true;
  }

  asBrowserWindow(): ElectronBrowserWindow {
    return this as unknown as ElectronBrowserWindow;
  }
}

describe('publishWindowFocus', () => {
  it("pushes the window's focus and blur to its own renderer", () => {
    const win = new FakeBrowserWindow(true);
    publishWindowFocus(win.asBrowserWindow());

    win.emit('blur');
    win.emit('focus');

    expect(win.sent).toEqual([
      { args: [false], channel: 'window-focus:changed' },
      { args: [true], channel: 'window-focus:changed' },
    ]);
  });

  it('keeps two windows independent: each pushes only to its own renderer', () => {
    const first = new FakeBrowserWindow(true);
    const second = new FakeBrowserWindow(false);
    publishWindowFocus(first.asBrowserWindow());
    publishWindowFocus(second.asBrowserWindow());

    second.emit('focus');

    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([{ args: [true], channel: 'window-focus:changed' }]);
  });

  it('drops a blur that arrives after the renderer is destroyed instead of throwing', () => {
    const win = new FakeBrowserWindow(true);
    publishWindowFocus(win.asBrowserWindow());
    win.destroy();

    // A window resigns key while it closes: `blur` can land after the
    // WebContents is gone, when the `webContents` getter and `send` both throw.
    expect(() => win.emit('blur')).not.toThrow();
    expect(win.sent).toEqual([]);
  });
});

describe('window-focus IPC handler', () => {
  type Handler = (...args: unknown[]) => unknown;
  let handlers: Map<string, Handler>;

  function liveWindow(focused: boolean, destroyed = false) {
    return { isDestroyed: () => destroyed, isFocused: () => focused };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as Handler);
    });
  });

  it('serves the asking window native focus on the manifest channel', async () => {
    registerWindowFocusIpcHandlers();
    const event = createTrustedInvokeEvent('visible-ui', 7301);
    const handler = handlers.get('window-focus:is-focused');
    expect(handler).toBeDefined();

    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(liveWindow(true) as never);
    await expect(handler?.(event)).resolves.toEqual({ ok: true, value: true });
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(liveWindow(false) as never);
    await expect(handler?.(event)).resolves.toEqual({ ok: true, value: false });
    expect(BrowserWindow.fromWebContents).toHaveBeenCalledWith(event.sender);
  });

  it.each([
    ['has no BrowserWindow', null],
    ['is destroyed', liveWindow(true, true)],
  ])('fails with the IpcResult taxonomy when the sender %s', async (_label, window) => {
    registerWindowFocusIpcHandlers();
    const event = createTrustedInvokeEvent('visible-ui', 7302);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as never);

    await expect(handlers.get('window-focus:is-focused')?.(event)).resolves.toEqual({
      error: {
        category: 'window-focus',
        code: 'window_unavailable',
        message: 'The requesting renderer has no live BrowserWindow.',
      },
      ok: false,
    });
  });

  it.each(['chunking-host', 'embedding-host', 'llm-host'] as const)(
    'rejects a %s sender before reading any window',
    async (role) => {
      registerWindowFocusIpcHandlers();
      const event = createTrustedInvokeEvent(role, 7303);

      await expect(handlers.get('window-focus:is-focused')?.(event)).rejects.toThrow(
        /window-focus:is-focused/
      );
      expect(BrowserWindow.fromWebContents).not.toHaveBeenCalled();
    }
  );

  it('rejects an untracked sender before reading any window', async () => {
    registerWindowFocusIpcHandlers();
    clearWindowRoleByWebContentsId(7304);
    const event = {
      sender: { id: 7304 },
      senderFrame: createAllowlistedSenderFrame('visible-ui'),
    };

    await expect(handlers.get('window-focus:is-focused')?.(event)).rejects.toThrow(
      /window-focus:is-focused/
    );
    expect(BrowserWindow.fromWebContents).not.toHaveBeenCalled();
  });

  it('unregisters the channel when disposed', () => {
    const dispose = registerWindowFocusIpcHandlers();
    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('window-focus:is-focused');
  });
});
