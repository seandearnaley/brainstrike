import { clipboard as electronClipboard, ipcMain } from 'electron';
import { type ClipboardLike, createClipboardIpcHandlers } from './ipc-clipboard-handlers';
import { clipboardContract } from './ipc-domains/clipboard.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';

export function registerClipboardIpcHandlers(
  clipboard: ClipboardLike = electronClipboard
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(
    registry,
    'clipboard',
    clipboardContract,
    createClipboardIpcHandlers({ clipboard })
  );
  return () => {
    registry.unregisterAll();
  };
}
