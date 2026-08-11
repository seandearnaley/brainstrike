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
  // ONE `message` listener dispatches to per-method handler sets — so N `on()`
  // calls never accumulate N emitter listeners (Electron's Debugger is an
  // EventEmitter with a default max of 10). Bound once, lazily.
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  let messageBound = false;

  // Attach lazily and re-attach transparently: Electron detaches the debugger
  // out from under us on ordinary events (DevTools opened on the tab, render
  // process crash+recreate, an external detach), all of which leave the tab
  // alive. Re-attaching on the next `send` keeps the cached session usable
  // instead of bricking it. If re-attach genuinely can't happen (e.g. DevTools
  // still open), `attach` THROWS — surfaced to the caller, never swallowed.
  const ensureAttached = (): void => {
    if (!dbg.isAttached()) {
      dbg.attach(CDP_PROTOCOL_VERSION);
    }
    if (!messageBound) {
      dbg.on('message', (_event, method, params) => {
        const set = handlers.get(method);
        if (set) {
          for (const handler of set) {
            handler(params);
          }
        }
      });
      messageBound = true;
    }
  };
  ensureAttached();

  return {
    detach: () => {
      // Idempotent: a tab close or a prior detach may already have released it.
      if (dbg.isAttached()) {
        dbg.detach();
      }
    },
    on: (event, handler) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
    },
    send: <T>(method: string, params?: Record<string, unknown>) => {
      ensureAttached();
      return dbg.sendCommand(method, params) as Promise<T>;
    },
  };
}
