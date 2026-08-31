/**
 * The renderer→main half of the workspace-open ready handshake (BST-1393,
 * PR #2682 re-review): `WorkspaceConnectHost` pings `workspace:open-path-ready`
 * the instant it subscribes to `onOpenPath`, and `createMainWindow` (`main.ts`)
 * uses that ping — together with the window having finished loading — to
 * decide when it is safe to attach `workspace-open-queue.ts` and flush
 * buffered folder-open requests.
 *
 * Registered exactly ONCE, at module scope, via the SAME
 * `createDesktopIpcRegistry` every other IPC domain in this app uses
 * (`runtime-host-boundary.test.ts`'s "keeps main process startup free of ad
 * hoc IPC registration" forbids a raw `ipcMain.on(...)` in `main.ts` itself —
 * this module is that registrar). Because the registry throws on a channel
 * registered twice, and `createMainWindow` runs again on every
 * `app.on('activate')` recreation, per-window routing happens INSIDE this
 * one global handler via `event.sender.id` — the same pattern
 * `logging-ipc.ts`'s `ingestBufferedLog(senderId, record)` already uses —
 * rather than by registering a fresh `ipcMain.on` per window.
 */
import { ipcMain } from 'electron';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export interface WorkspaceOpenReadyIpcHandlers {
  /**
   * A renderer pinged ready. `senderWebContentsId` is `WebContents.id` —
   * plain, stable, comparable-by-value, unlike the `IpcMainEvent.sender`
   * object itself — so the caller can route it to the correct window's
   * per-window state (a Map keyed by this id) without holding onto Electron
   * event objects.
   */
  readonly onOpenPathReady: (signal: WorkspaceOpenReadySignal) => void;
}

export type WorkspaceOpenReadySignal =
  | {
      readonly kind: 'ready';
      readonly resetGeneration: string | null;
      readonly senderWebContentsId: number;
    }
  | {
      readonly diagnostic: string;
      readonly kind: 'invalid';
      readonly senderWebContentsId: number;
    };

const readResetGeneration = (payload: unknown): string | null | undefined => {
  if (!(payload && typeof payload === 'object')) {
    return undefined;
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== 'resetGeneration') {
    return undefined;
  }
  const resetGeneration = (payload as Record<string, unknown>)['resetGeneration'];
  if (resetGeneration === null) {
    return null;
  }
  return typeof resetGeneration === 'string' && resetGeneration.length > 0
    ? resetGeneration
    : undefined;
};

/**
 * Registers the `workspace:open-path-ready` event channel. Call ONCE, at
 * module scope in `main.ts` (matching where `workspace-open-queue.ts`'s
 * queue itself is created) — never per-window. Returns an unregister
 * function for symmetry with every other `register*IpcHandlers` factory in
 * this app; nothing currently calls it (the channel lives for the app's
 * whole lifetime), but a future desktop shutdown/reset path may want to.
 */
export function registerWorkspaceOpenReadyIpcHandlers(
  handlers: WorkspaceOpenReadyIpcHandlers
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerEvent(
    'workspace',
    DESKTOP_IPC_CHANNELS.workspace.openPathReady,
    (event, payload: unknown) => {
      const senderWebContentsId = event.sender.id;
      if (!event.senderFrame) {
        handlers.onOpenPathReady({
          diagnostic: `Renderer ${senderWebContentsId} readiness acknowledgement has no sender frame`,
          kind: 'invalid',
          senderWebContentsId,
        });
        return;
      }
      const resetGeneration = readResetGeneration(payload);
      if (resetGeneration === undefined) {
        handlers.onOpenPathReady({
          diagnostic: `Renderer ${senderWebContentsId} readiness acknowledgement has malformed payload`,
          kind: 'invalid',
          senderWebContentsId,
        });
        return;
      }
      handlers.onOpenPathReady({
        kind: 'ready',
        resetGeneration,
        senderWebContentsId,
      });
    }
  );

  return () => {
    registry.unregisterAll();
  };
}
