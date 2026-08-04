import { ipcMain } from 'electron';
import { type ChangesIpcHandlers, createChangesIpcHandlers } from './changes-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Register the desktop `changes` IPC domain.
 *
 * BST-1113 Task 1 wires typed stub handlers (visible `not-implemented`
 * `GitResult` failures); Task 3 lands `ChangesetDiffService` and Task 4
 * replaces the stub with the real `resolveView`/`fileDiff` implementations,
 * in the same PR. See {@link createChangesIpcHandlers}.
 */
export function registerChangesIpcHandlers(
  handlers: ChangesIpcHandlers = createChangesIpcHandlers()
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.resolveView,
    (_event, rootId: unknown, changeset: unknown) => handlers.resolveView(rootId, changeset)
  );
  registry.registerInvoke(
    'changes',
    DESKTOP_IPC_CHANNELS.changes.fileDiff,
    (_event, rootId: unknown, changeset: unknown, path: unknown) =>
      handlers.fileDiff(rootId, changeset, path)
  );

  return () => {
    registry.unregisterAll();
  };
}
