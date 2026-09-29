import { ipcMain } from 'electron';
import { worktreesContract } from './ipc-domains/worktrees.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';
import type { WorktreesIpcHandlers } from './worktrees-ipc-handlers';

/**
 * Register the desktop `worktrees` IPC domain (BST-1390). Every payload arrives
 * as `unknown` and is narrowed inside the handler, like `ipc-changes.ts`.
 */
export function registerWorktreesIpcHandlers(handlers: WorktreesIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'worktrees', worktreesContract, handlers);

  return () => {
    registry.unregisterAll();
  };
}
