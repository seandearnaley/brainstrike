import { ipcMain } from 'electron';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import type { WorktreesIpcHandlers } from './worktrees-ipc-handlers';

/**
 * Register the desktop `worktrees` IPC domain (BST-1390). Every payload arrives
 * as `unknown` and is narrowed inside the handler, like `ipc-changes.ts`.
 */
export function registerWorktreesIpcHandlers(handlers: WorktreesIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.archive,
    (_event, payload: unknown) => handlers.archive(payload)
  );
  registry.registerInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.create,
    (_event, payload: unknown) => handlers.create(payload)
  );
  registry.registerInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.createBranchHere,
    (_event, payload: unknown) => handlers.createBranchHere(payload)
  );
  registry.registerInvoke('worktrees', DESKTOP_IPC_CHANNELS.worktrees.getSettings, () =>
    handlers.getSettings()
  );
  registry.registerInvoke('worktrees', DESKTOP_IPC_CHANNELS.worktrees.list, () => handlers.list());
  registry.registerInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.restore,
    (_event, payload: unknown) => handlers.restore(payload)
  );
  registry.registerInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.setSettings,
    (_event, payload: unknown) => handlers.setSettings(payload)
  );

  return () => {
    registry.unregisterAll();
  };
}
