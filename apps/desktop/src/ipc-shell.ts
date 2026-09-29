import { shell as electronShell, ipcMain } from 'electron';
import { createShellIpcHandlers, type ShellIpcHandlers } from './ipc-shell-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerShellIpcHandlers(
  handlers: ShellIpcHandlers = createShellIpcHandlers({ shell: electronShell })
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerAuthorizedInvoke(
    'shell',
    DESKTOP_IPC_CHANNELS.shell.showItemInFolder,
    { roles: ['visible-ui'] },
    (_event, rawPath: unknown) => handlers.showItemInFolder(rawPath)
  );
  registry.registerAuthorizedInvoke(
    'shell',
    DESKTOP_IPC_CHANNELS.shell.openPath,
    { roles: ['visible-ui'] },
    (_event, rawPath: unknown) => handlers.openPath(rawPath)
  );
  registry.registerAuthorizedInvoke(
    'shell',
    DESKTOP_IPC_CHANNELS.shell.openExternal,
    { roles: ['visible-ui'] },
    (_event, url: unknown) => handlers.openExternal(url)
  );

  return () => {
    registry.unregisterAll();
  };
}
