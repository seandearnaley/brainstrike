import { ipcMain } from 'electron';
import { getProjectHooksForReview } from './ipc-hooks-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerHooksIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.getProjectHooksForReview,
    (_event, rootId: unknown, absPath: unknown) => getProjectHooksForReview(rootId, absPath)
  );

  return () => {
    registry.unregisterAll();
  };
}
