import { ipcMain } from 'electron';
import { scanWorkspaceContextFilesForReview } from './ipc-context-files-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerContextFilesIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('contextFiles', DESKTOP_IPC_CHANNELS.contextFiles.scan, () =>
    scanWorkspaceContextFilesForReview()
  );

  return () => {
    registry.unregisterAll();
  };
}
