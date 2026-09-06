import { ipcMain } from 'electron';
import { type ChangesIpcHandlers, createChangesIpcHandlers } from './changes-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Register the desktop `changes` IPC domain (BST-1113), wiring the real
 * `ChangesetDiffService`-backed handlers. See {@link createChangesIpcHandlers}.
 */
export function registerChangesIpcHandlers(
  handlers: ChangesIpcHandlers = createChangesIpcHandlers()
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerAuthorizedInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.resolveView,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, changeset: unknown) => handlers.resolveView(rootId, changeset)
  );
  registry.registerAuthorizedInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.fileDiff,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, changeset: unknown, path: unknown) =>
      handlers.fileDiff(rootId, changeset, path)
  );
  registry.registerAuthorizedInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.inventory,
    { roles: ['visible-ui'] },
    (_event, options: unknown) => handlers.inventory(options)
  );
  // Conversation Rewind (BST-1115 W5 T4). Every payload arrives as `unknown`
  // and is narrowed inside the handler, same as the two above.
  registry.registerAuthorizedInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.rewindPreview,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.rewindPreview(payload)
  );
  registry.registerAuthorizedInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.applyRewind,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.applyRewind(payload)
  );
  registry.registerAuthorizedInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.redoRewind,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.redoRewind(payload)
  );
  registry.registerAuthorizedInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.finalizeRewinds,
    { roles: ['visible-ui'] },
    (_event, payload: unknown) => handlers.finalizeRewinds(payload)
  );

  return () => {
    registry.unregisterAll();
  };
}
