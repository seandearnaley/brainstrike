import type { AssistantServerAuthResult } from '@brainstrike/assistant-contract';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import type { DesktopPowerSnapshot } from './platform/desktop-power-snapshot';

interface ReloadIntent {
  readonly reason: string;
  readonly source: 'renderer';
}

interface MainPlatformIpcDependencies {
  /** null = still starting; { startupError } = the server failed to start. */
  readonly getAssistantAuth: () => AssistantServerAuthResult;
  readonly getAssistantUrl: () => string;
  readonly getPowerSnapshot: () => DesktopPowerSnapshot;
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
  getAssistantAuth,
  getAssistantUrl,
  getPowerSnapshot,
  noteNextWindowReload,
}: MainPlatformIpcDependencies): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('agent', DESKTOP_PRELOAD_IPC_CHANNELS.agent.assistantGetUrl, () =>
    getAssistantUrl()
  );

  registry.registerInvoke('agent', DESKTOP_PRELOAD_IPC_CHANNELS.agent.assistantGetAuth, () =>
    getAssistantAuth()
  );

  registry.registerInvoke('runtime', DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerSnapshot, () =>
    getPowerSnapshot()
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
