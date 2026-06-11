import { shell as electronShell, ipcMain } from 'electron';
import { createShellIpcHandlers } from './ipc-shell-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerShellIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const handlers = createShellIpcHandlers({ shell: electronShell });

  registry.registerInvoke(
    'shell',
    DESKTOP_IPC_CHANNELS.shell.showItemInFolder,
    (_event, rawPath: unknown) => handlers.showItemInFolder(rawPath)
  );
  registry.registerInvoke(
    'shell',
    DESKTOP_IPC_CHANNELS.shell.openPath,
    (_event, rawPath: unknown) => handlers.openPath(rawPath)
  );

  return () => {
    registry.unregisterAll();
  };
}
