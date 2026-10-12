import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import type { DesktopPowerSnapshot } from './platform/desktop-power-snapshot';

const EMBEDDING_HOST_SHARED_SENDER_POLICY = {
  reason:
    'Invoked by the visible UI and the embedding-host hidden host (dist/hidden-preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;
const VISIBLE_ONLY_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

interface ReloadIntent {
  readonly reason: string;
  readonly source: 'renderer';
}

interface MainPlatformIpcDependencies {
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
  getPowerSnapshot,
  noteNextWindowReload,
}: MainPlatformIpcDependencies): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'runtime',
    DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerSnapshot,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
    () => getPowerSnapshot()
  );

  registry.registerUnauthenticatedInvoke(
    'runtime',
    DESKTOP_PRELOAD_IPC_CHANNELS.runtime.noteReloadIntent,
    VISIBLE_ONLY_SENDER_POLICY,
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
