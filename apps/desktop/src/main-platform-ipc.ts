import { Schema } from 'effect';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { NonBlankString } from './platform/ipc-args';

interface ReloadIntent {
  readonly reason: string;
  readonly source: 'renderer';
}

interface MainPlatformIpcDependencies {
  readonly noteNextWindowReload: (window: BrowserWindow, intent: ReloadIntent) => void;
  readonly requestReload: (window: BrowserWindow, reason: string) => void;
}

function getLiveSenderWindow(sender: WebContents): BrowserWindow {
  const window = BrowserWindow.fromWebContents(sender);
  if (window && !window.isDestroyed()) {
    return window;
  }
  throw new Error('Renderer reload intent must originate from a live BrowserWindow.');
}

/** A reload's reason: nonblank, trimmed by the handler. */
const ReloadReasonArgs = Schema.Tuple([NonBlankString]);

export function registerMainPlatformIpcHandlers({
  noteNextWindowReload,
  requestReload,
}: MainPlatformIpcDependencies): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.handle(
    'runtime',
    DESKTOP_IPC_CHANNELS.runtime.noteReloadIntent,
    ReloadReasonArgs,
    async (event, reason): Promise<void> => {
      const normalizedReason = reason.trim();
      const window = getLiveSenderWindow(event.sender);
      if (window.isDestroyed()) {
        throw new Error('Renderer reload intent must originate from a live BrowserWindow.');
      }
      noteNextWindowReload(window, {
        reason: normalizedReason,
        source: 'renderer',
      });
    }
  );

  registry.handle(
    'runtime',
    DESKTOP_IPC_CHANNELS.runtime.requestReload,
    ReloadReasonArgs,
    (event, reason): void => {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Renderer reload must originate from the current main frame.');
      }
      requestReload(getLiveSenderWindow(event.sender), reason.trim());
    }
  );

  return () => {
    registry.unregisterAll();
  };
}
