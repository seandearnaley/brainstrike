import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

interface ReloadIntent {
  readonly reason: string;
  readonly source: 'renderer';
}

interface MainPlatformIpcDependencies {
  readonly getAssistantUrl: () => string;
  readonly noteNextWindowReload: (window: BrowserWindow, intent: ReloadIntent) => void;
}

function getLiveSenderWindow(sender: WebContents): BrowserWindow {
  const window = BrowserWindow.fromWebContents(sender);
  if (window && !window.isDestroyed()) {
    return window;
  }
  throw new Error('Renderer reload intent must originate from a live BrowserWindow.');
}

function normalizeReloadIntentReason(reason: unknown): string {
  if (typeof reason !== 'string') {
    throw new Error('Renderer reload intent reason must be a non-empty string.');
  }
  const normalized = reason.trim();
  if (normalized.length > 0) {
    return normalized;
  }
  throw new Error('Renderer reload intent reason must be a non-empty string.');
}

export function registerMainPlatformIpcHandlers({
  getAssistantUrl,
  noteNextWindowReload,
}: MainPlatformIpcDependencies): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('agent', DESKTOP_PRELOAD_IPC_CHANNELS.agent.assistantGetUrl, () =>
    getAssistantUrl()
  );

  registry.registerInvoke(
    'runtime',
    DESKTOP_PRELOAD_IPC_CHANNELS.runtime.noteReloadIntent,
    async (event, reason: unknown): Promise<void> => {
      const normalizedReason = normalizeReloadIntentReason(reason);
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

  return () => {
    registry.unregisterAll();
  };
}
