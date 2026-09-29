import { ipcMain } from 'electron';
import { type ChangesIpcHandlers, createChangesIpcHandlers } from './changes-ipc-handlers';
import { changesContract } from './ipc-domains/changes.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';

/**
 * Register the desktop `changes` IPC domain (BST-1113), wiring the real
 * `ChangesetDiffService`-backed handlers. See {@link createChangesIpcHandlers}.
 */
export function registerChangesIpcHandlers(
  handlers: ChangesIpcHandlers = createChangesIpcHandlers()
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'changes', changesContract, handlers);

  return () => {
    registry.unregisterAll();
  };
}
