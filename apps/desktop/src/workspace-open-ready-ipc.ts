/**
 * The renderer's WorkspaceConnectHost invokes `workspace:open-path-ready`
 * when it subscribes to open-path pushes. main.ts waits for this ping and
 * for the window load before flushing queued folder-open requests.
 * The handler is registered once and routes by `event.sender.id`.
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
 * Registers the `workspace:open-path-ready` method. Call ONCE, at
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

  registry.handle(
    'workspace',
    DESKTOP_IPC_CHANNELS.workspace.openPathReady,
    (event, payload: unknown) => {
      const senderWebContentsId = event.sender.id;
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
