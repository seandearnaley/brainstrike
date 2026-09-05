import { ipcMain } from 'electron';
import { scanWorkspaceContextFilesForReview } from './ipc-context-files-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

export function registerContextFilesIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'contextFiles',
    DESKTOP_IPC_CHANNELS.contextFiles.scan,
    UNAUTHENTICATED_SENDER_POLICY,
    () => scanWorkspaceContextFilesForReview()
  );

  return () => {
    registry.unregisterAll();
  };
}
