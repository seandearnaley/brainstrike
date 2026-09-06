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

  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.adopt,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.adopt(payload)
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.archive,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.archive(payload)
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.checkoutStatus,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.checkoutStatus(payload)
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.create,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.create(payload)
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.createBranchHere,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.createBranchHere(payload)
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.createContext,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.createContext(payload)
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.getSettings,
    { roles: ['visible-ui'] },
    () => handlers.getSettings()
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.inspectArchive,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.inspectArchive(payload)
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.list,
    { roles: ['visible-ui'] },
    () => handlers.list()
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.managedPaths,
    { roles: ['visible-ui'] },
    () => handlers.listManagedPaths()
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.restore,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.restore(payload)
  );
  registry.registerAuthorizedInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.setSettings,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.setSettings(payload)
  );

  return () => {
    registry.unregisterAll();
  };
}
