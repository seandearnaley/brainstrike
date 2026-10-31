import { app, ipcMain } from 'electron';
import { createFileExportsIpcHandlers, SaveToDownloadsArgs } from './ipc-file-exports-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerFileExportsIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const handlers = createFileExportsIpcHandlers({
    getDownloadsPath: () => app.getPath('downloads'),
  });

  registry.handle(
    'fileExports',
    DESKTOP_IPC_CHANNELS.fileExports.saveToDownloads,
    SaveToDownloadsArgs,
    (_event, payload) => handlers.saveToDownloads(payload)
  );

  return () => {
    registry.unregisterAll();
  };
}
