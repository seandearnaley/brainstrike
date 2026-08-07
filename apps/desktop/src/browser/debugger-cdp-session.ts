/**
 * Adapts Electron's `webContents.debugger` to the narrow {@link CdpSession}
 * the driver speaks (BST-1176). This is the in-process CDP transport — no
 * remote-debugging-port, so no app-wide unauthenticated CDP surface.
 *
 * Only `webContents.debugger`'s five methods are referenced through the
 * {@link DebuggerLike} structural type, keeping this unit-testable without a
 * live WebContents and pinning the exact Electron surface we depend on.
 */
import type { CdpSession } from './browser-driver';

/** The subset of Electron's `Debugger` this transport uses. */
export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  on(event: string, listener: (event: unknown, method: string, params: unknown) => void): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

/** CDP protocol version pinned for `Debugger.attach`. */
const CDP_PROTOCOL_VERSION = '1.3';

export function createDebuggerCdpSession(dbg: DebuggerLike): CdpSession {
  if (!dbg.isAttached()) {
    dbg.attach(CDP_PROTOCOL_VERSION);
  }
  return {
    detach: () => {
      // Idempotent: a tab close or a prior detach may already have released it.
      if (dbg.isAttached()) {
        dbg.detach();
      }
    },
    on: (event, handler) => {
      dbg.on('message', (_event, method, params) => {
        if (method === event) {
          handler(params);
        }
      });
    },
    send: <T>(method: string, params?: Record<string, unknown>) =>
      dbg.sendCommand(method, params) as Promise<T>,
  };
}
