import { shell as electronShell, ipcMain } from 'electron';
import { createShellIpcHandlers, type ShellIpcHandlers } from './ipc-shell-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerShellIpcHandlers(
  handlers: ShellIpcHandlers = createShellIpcHandlers({ shell: electronShell })
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.handle(
    'shell',
    DESKTOP_IPC_CHANNELS.shell.showItemInFolder,
    (_event, rawPath: unknown) => handlers.showItemInFolder(rawPath)
  );
  registry.handle('shell', DESKTOP_IPC_CHANNELS.shell.openPath, (_event, rawPath: unknown) =>
    handlers.openPath(rawPath)
  );
  registry.handle('shell', DESKTOP_IPC_CHANNELS.shell.openExternal, (_event, url: unknown) =>
    handlers.openExternal(url)
  );

  return () => {
    registry.unregisterAll();
  };
}
