import type { IpcMainInvokeEvent } from 'electron';
import { vi } from 'vitest';
import { trackAppWindow } from '../../app-windows';
import { DESKTOP_IPC_INVOKE_CHANNEL } from '../../platform/desktop-ipc-channels';
import { createAllowlistedSenderFrame } from './desktop-ipc-sender-frame-test-allowlist';

export { createAllowlistedSenderFrame } from './desktop-ipc-sender-frame-test-allowlist';

/** Tracks a test app window by webContents id. */
export function trackTestAppWindow(webContentsId: number): void {
  trackAppWindow({
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: { id: webContentsId },
  } as never);
}

const DEFAULT_TRUSTED_SENDER_ID = 990_001;

/**
 * Builds an invoke event that passes BOTH authorization factors: the sender id
 * is tracked as an app window and the frame URL is allowlisted.
 */
export function createTrustedInvokeEvent(
  webContentsId: number = DEFAULT_TRUSTED_SENDER_ID
): IpcMainInvokeEvent {
  trackTestAppWindow(webContentsId);
  return {
    sender: { id: webContentsId },
    senderFrame: createAllowlistedSenderFrame(),
  } as unknown as IpcMainInvokeEvent;
}

type DesktopIpcDispatcher = (
  event: IpcMainInvokeEvent,
  method: unknown,
  ...args: unknown[]
) => Promise<unknown>;

/** A fake `ipcMain` whose `handle` is a Vitest mock. */
interface IpcMainFake {
  readonly getHandler?: (channel: string) => unknown;
  readonly handle: unknown;
}

// The registry installs its dispatcher once per ipcMain for the life of the
// registry module, so a later `vi.clearAllMocks()` must not lose it.
const dispatchers = new WeakMap<object, DesktopIpcDispatcher>();

function findDesktopIpcDispatcher(ipcMain: IpcMainFake): DesktopIpcDispatcher {
  if (!vi.isMockFunction(ipcMain.handle)) {
    throw new Error('The ipcMain fake must record `handle` with vi.fn().');
  }
  let registered: unknown = ipcMain.handle.mock.calls
    .filter(([channel]) => channel === DESKTOP_IPC_INVOKE_CHANNEL)
    .at(-1)?.[1];
  if (typeof registered !== 'function' && typeof ipcMain.getHandler === 'function') {
    registered = ipcMain.getHandler(DESKTOP_IPC_INVOKE_CHANNEL);
  }
  if (typeof registered === 'function') {
    dispatchers.set(ipcMain, registered as DesktopIpcDispatcher);
    return registered as DesktopIpcDispatcher;
  }
  const remembered = dispatchers.get(ipcMain);
  if (!remembered) {
    throw new Error(`No dispatcher is registered on ${DESKTOP_IPC_INVOKE_CHANNEL}.`);
  }
  return remembered;
}

/**
 * Calls `method` on the desktop's one IPC connection, as the renderer would,
 * from `event`'s sender. Use it to assert what the dispatcher refuses.
 */
export function invokeDesktopIpcFrom(
  ipcMain: IpcMainFake,
  event: unknown,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  return findDesktopIpcDispatcher(ipcMain)(event as IpcMainInvokeEvent, method, ...args);
}

/** Calls `method` on the desktop's one IPC connection from a trusted app window. */
export function invokeDesktopIpc(
  ipcMain: IpcMainFake,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  return invokeDesktopIpcFrom(ipcMain, createTrustedInvokeEvent(), method, ...args);
}
