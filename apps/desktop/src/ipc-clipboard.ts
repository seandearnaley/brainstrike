import { ClipboardItem, clipboard, ipcMain } from 'electron';
import {
  type ClipboardLike,
  clipboardArgs,
  createClipboardIpcHandlers,
} from './ipc-clipboard-handlers';
import { clipboardContract } from './ipc-domains/clipboard.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';

const electronClipboard: ClipboardLike = {
  // `slice()` copies onto a plain ArrayBuffer, which is what a Blob takes.
  writeImage: (png) =>
    clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([png.slice()], { type: 'image/png' }) }),
    ]),
  writeText: (text) => clipboard.writeText(text),
};

export function registerClipboardIpcHandlers(
  target: ClipboardLike = electronClipboard
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(
    registry,
    'clipboard',
    clipboardContract,
    clipboardArgs,
    createClipboardIpcHandlers({ clipboard: target })
  );
  return () => {
    registry.unregisterAll();
  };
}
