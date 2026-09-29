import { ipcMain } from 'electron';
import type { ForgeIpcHandlers } from './forge-ipc-handlers';
import { forgeContract } from './ipc-domains/forge.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';

/**
 * Register the desktop `forge` IPC domain (BST-1391).
 *
 * `prUpdated` is deliberately absent: it is a one-way main→renderer push
 * broadcast from `main.ts`, never an invoke channel.
 */
export function registerForgeIpcHandlers(handlers: ForgeIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'forge', forgeContract, handlers);

  return () => {
    registry.unregisterAll();
  };
}
