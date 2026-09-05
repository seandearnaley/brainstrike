import { clipboard as electronClipboard, ipcMain } from 'electron';
import { createClipboardIpcHandlers } from './ipc-clipboard-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

export function registerClipboardIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const handlers = createClipboardIpcHandlers({ clipboard: electronClipboard });

  registry.registerUnauthenticatedInvoke(
    'clipboard',
    DESKTOP_IPC_CHANNELS.clipboard.writeText,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, rawText: unknown) => handlers.writeText(rawText)
  );

  return () => {
    registry.unregisterAll();
  };
}
