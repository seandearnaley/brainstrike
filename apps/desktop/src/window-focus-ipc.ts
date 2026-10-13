import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { windowFocusContract } from './ipc-domains/window-focus.contract';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { type IpcResult, ipcFailure, ipcOk } from './platform/ipc-contract';

/**
 * Publishes a window's NATIVE focus to its own renderer (BST-1864), so the
 * renderer's "app active" signal follows the OS window instead of its own
 * `document.hasFocus()`.
 *
 * The premise, verified in Electron 44: focusing a child `WebContentsView` (the
 * browser pane) or docked DevTools emits no `blur` on the host `BrowserWindow`
 * and `isFocused()` stays true — while the renderer's `document.hasFocus()` goes
 * false. A detached DevTools window is a separate OS window and DOES take key
 * status, so this window reads blurred then; that is the same as switching to
 * any other window.
 *
 * The pushed value is the event itself (`focus` → true, `blur` → false): the
 * transition `win.isFocused()` reports, so a push and the on-request read agree.
 */
export function publishWindowFocus(win: BrowserWindow): void {
  // Captured NOW, not read in a listener: a window resigns key while it closes,
  // so `blur` can land after the WebContents is gone, and by then the
  // `win.webContents` getter and `send` both THROW "Object has been destroyed".
  const { webContents } = win;
  const publish = (focused: boolean): void => {
    if (webContents.isDestroyed()) {
      return;
    }
    webContents.send(DESKTOP_IPC_CHANNELS.windowFocus.changed, focused);
  };
  win.on('focus', () => {
    publish(true);
  });
  win.on('blur', () => {
    publish(false);
  });
}

function readSenderWindowFocus(sender: WebContents): IpcResult<boolean> {
  const window = BrowserWindow.fromWebContents(sender);
  if (window === null || window.isDestroyed()) {
    return ipcFailure(
      refusal({
        category: 'availability',
        code: 'window.unavailable',
        message: 'This window is no longer available.',
      })
    );
  }
  return ipcOk(window.isFocused());
}

/**
 * Registers `window-focus:is-focused`. Event-aware, not a plain `registerDomain`
 * handler: the answer is about the ASKING renderer's window, so it binds to the
 * registry-authenticated `event.sender` (the same audited exception notes-vault
 * watchers use). The `window-focus:changed` push is never registered.
 */
export function registerWindowFocusIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registry.registerAuthorizedInvoke(
    'windowFocus',
    windowFocusContract.isFocused.channel,
    { roles: windowFocusContract.isFocused.roles },
    (event: IpcMainInvokeEvent, ...raw: readonly unknown[]) => {
      windowFocusContract.isFocused.parseArgs(raw);
      return readSenderWindowFocus(event.sender);
    }
  );
  return () => {
    registry.unregisterAll();
  };
}
