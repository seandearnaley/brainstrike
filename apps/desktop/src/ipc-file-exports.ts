import { app, ipcMain } from 'electron';
import { createFileExportsIpcHandlers } from './ipc-file-exports-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

export function registerFileExportsIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const handlers = createFileExportsIpcHandlers({
    getDownloadsPath: () => app.getPath('downloads'),
  });

  registry.registerUnauthenticatedInvoke(
    'fileExports',
    DESKTOP_IPC_CHANNELS.fileExports.saveToDownloads,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, rawPayload: unknown) => handlers.saveToDownloads(rawPayload)
  );

  return () => {
    registry.unregisterAll();
  };
}
