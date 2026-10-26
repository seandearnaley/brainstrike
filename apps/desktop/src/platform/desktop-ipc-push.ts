import type { MessagePortMain } from 'electron';
import { DESKTOP_IPC_PUSH_CHANNEL, type DesktopIpcPush } from './desktop-ipc-channels';

/** Sends one method's push to a renderer over the desktop's one push channel. */
export function pushToRenderer(
  target: { send(channel: string, push: DesktopIpcPush): void },
  method: string,
  payload?: unknown
): void {
  target.send(DESKTOP_IPC_PUSH_CHANNEL, { method, payload });
}

/** Sends one method's push to a frame with ports it transfers, on the same push channel. */
export function pushToFrame(
  frame: {
    postMessage(channel: string, push: DesktopIpcPush, transfer: MessagePortMain[]): void;
  },
  method: string,
  payload: unknown,
  transfer: MessagePortMain[] = []
): void {
  frame.postMessage(DESKTOP_IPC_PUSH_CHANNEL, { method, payload }, transfer);
}
