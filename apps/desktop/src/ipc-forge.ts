import { ipcMain } from 'electron';
import type { ForgeIpcHandlers } from './forge-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

/**
 * Register the desktop `forge` IPC domain (BST-1391).
 *
 * `prUpdated` is deliberately absent: it is a one-way main→renderer push
 * broadcast from `main.ts`, never an invoke channel.
 */
export function registerForgeIpcHandlers(handlers: ForgeIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'forge',
    DESKTOP_IPC_CHANNELS.forge.identity,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, rootId: unknown) => handlers.identity(rootId)
  );
  registry.registerUnauthenticatedInvoke(
    'forge',
    DESKTOP_IPC_CHANNELS.forge.prStatus,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, rootId: unknown) => handlers.prStatus(rootId)
  );
  registry.registerUnauthenticatedInvoke(
    'forge',
    DESKTOP_IPC_CHANNELS.forge.refresh,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, rootId: unknown, params: unknown) => handlers.refresh(rootId, params)
  );

  return () => {
    registry.unregisterAll();
  };
}
