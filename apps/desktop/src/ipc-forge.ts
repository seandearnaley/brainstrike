import { ipcMain } from 'electron';
import type { ForgeIpcHandlers } from './forge-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Register the desktop `forge` IPC domain (BST-1391).
 *
 * `prUpdated` is deliberately absent: it is a one-way main→renderer push
 * broadcast from `main.ts`, never an invoke channel.
 */
export function registerForgeIpcHandlers(handlers: ForgeIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('forge', DESKTOP_IPC_CHANNELS.forge.identity, (_event, rootId: unknown) =>
    handlers.identity(rootId)
  );
  registry.registerInvoke('forge', DESKTOP_IPC_CHANNELS.forge.prStatus, (_event, rootId: unknown) =>
    handlers.prStatus(rootId)
  );
  registry.registerInvoke(
    'forge',
    DESKTOP_IPC_CHANNELS.forge.refresh,
    (_event, rootId: unknown, params: unknown) => handlers.refresh(rootId, params)
  );

  return () => {
    registry.unregisterAll();
  };
}
