import { BrowserWindow, type BrowserWindow as ElectronBrowserWindow, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { untrackAppWindow } from '../../app-windows';
import { DESKTOP_IPC_PUSH_CHANNEL } from '../../platform/desktop-ipc-channels';
import { publishWindowFocus, registerWindowFocusIpcHandlers } from '../../window-focus-ipc';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
  invokeDesktopIpcFrom,
} from '../helpers/desktop-ipc-sender-test-helpers';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

function focusPush(focused: boolean) {
  return {
    args: [{ method: 'window-focus:changed', payload: focused }],
    channel: DESKTOP_IPC_PUSH_CHANNEL,
  };
}

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

    expect(win.sent).toEqual([focusPush(false), focusPush(true)]);
  });

  it('keeps two windows independent: each pushes only to its own renderer', () => {
    const first = new FakeBrowserWindow(true);
    const second = new FakeBrowserWindow(false);
    publishWindowFocus(first.asBrowserWindow());
    publishWindowFocus(second.asBrowserWindow());

    second.emit('focus');

    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([focusPush(true)]);
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
  let dispose: (() => void) | undefined;

  function liveWindow(focused: boolean, destroyed = false) {
    return { isDestroyed: () => destroyed, isFocused: () => focused };
  }

  function isFocused(event: unknown): Promise<unknown> {
    return invokeDesktopIpcFrom(ipcMain, event, 'window-focus:is-focused');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dispose = registerWindowFocusIpcHandlers();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('serves the asking window native focus on the manifest method', async () => {
    const event = createTrustedInvokeEvent(7301);

    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(liveWindow(true) as never);
    await expect(isFocused(event)).resolves.toEqual({ ok: true, value: true });
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(liveWindow(false) as never);
    await expect(isFocused(event)).resolves.toEqual({ ok: true, value: false });
    expect(BrowserWindow.fromWebContents).toHaveBeenCalledWith(event.sender);
  });

  it.each([
    ['has no BrowserWindow', null],
    ['is destroyed', liveWindow(true, true)],
  ])('fails with the boundary failure taxonomy when the sender %s', async (_label, window) => {
    const event = createTrustedInvokeEvent(7302);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as never);

    await expect(isFocused(event)).resolves.toEqual({
      error: {
        category: 'availability',
        code: 'window.unavailable',
        kind: 'refusal',
        message: 'This window is no longer available.',
      },
      ok: false,
    });
  });

  it('rejects an untracked sender before reading any window', async () => {
    untrackAppWindow(7304);
    const event = {
      sender: { id: 7304 },
      senderFrame: createAllowlistedSenderFrame(),
    };

    await expect(isFocused(event)).rejects.toThrow(
      'Desktop IPC window-focus:is-focused requires an app window sender.'
    );
    expect(BrowserWindow.fromWebContents).not.toHaveBeenCalled();
  });

  it('stops serving the method when disposed', async () => {
    dispose?.();
    dispose = undefined;

    await expect(isFocused(createTrustedInvokeEvent(7305))).rejects.toThrow(
      'No desktop IPC handler for window-focus:is-focused.'
    );
    expect(BrowserWindow.fromWebContents).not.toHaveBeenCalled();
  });
});
