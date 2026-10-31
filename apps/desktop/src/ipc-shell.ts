import { Schema } from 'effect';
import { shell as electronShell, ipcMain } from 'electron';
import { createShellIpcHandlers, type ShellIpcHandlers } from './ipc-shell-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerShellIpcHandlers(
  handlers: ShellIpcHandlers = createShellIpcHandlers({ shell: electronShell })
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const target = Schema.Tuple([Schema.String]);

  registry.handle('shell', DESKTOP_IPC_CHANNELS.shell.showItemInFolder, target, (_event, rawPath) =>
    handlers.showItemInFolder(rawPath)
  );
  registry.handle('shell', DESKTOP_IPC_CHANNELS.shell.openPath, target, (_event, rawPath) =>
    handlers.openPath(rawPath)
  );
  registry.handle('shell', DESKTOP_IPC_CHANNELS.shell.openExternal, target, (_event, url) =>
    handlers.openExternal(url)
  );

  return () => {
    registry.unregisterAll();
  };
}
