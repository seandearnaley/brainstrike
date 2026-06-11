import { clipboard as electronClipboard, ipcMain } from 'electron';
import { createClipboardIpcHandlers } from './ipc-clipboard-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerClipboardIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const handlers = createClipboardIpcHandlers({ clipboard: electronClipboard });

  registry.registerInvoke(
    'clipboard',
    DESKTOP_IPC_CHANNELS.clipboard.writeText,
    (_event, rawText: unknown) => handlers.writeText(rawText)
  );

  return () => {
    registry.unregisterAll();
  };
}
