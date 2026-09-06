import type { AssistantServerAuthResult } from '@brainstrike/assistant-contract';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import type { DesktopPowerSnapshot } from './platform/desktop-power-snapshot';
import {
  forgetAssistantAuthIssuance,
  recordAssistantAuthIssuance,
} from './provider-auth/assistant-auth-origin';

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

  // Renderer reloads preserve the WebContents, and every reload re-requests
  // auth — without this guard each issuance stacks another 'destroyed'
  // listener on the same sender (MaxListenersExceededWarning after ~11).
  // One listener per WebContents suffices: the issuance record is keyed by
  // sender id, which is stable until 'destroyed'.
  const sendersWithDestroyedListener = new WeakSet<WebContents>();

  registry.registerAuthorizedInvoke(
    'agent',
    DESKTOP_PRELOAD_IPC_CHANNELS.agent.assistantGetUrl,
    { roles: ['visible-ui'] },
    () => getAssistantUrl()
  );

  registry.registerAuthorizedInvoke(
    'agent',
    DESKTOP_PRELOAD_IPC_CHANNELS.agent.assistantGetAuth,
    { roles: ['visible-ui'] },
    (event) => {
      const result = getAssistantAuth();
      // BST-1356: remember WHO holds the assistant bearer token. The channel's
      // role policy already guarantees `visible-ui` here; recording the sender
      // lets the credential-resolution layer enforce constraint 4 per origin
      // instead of falling back to a process-wide window probe. Only record on
      // an actual token issuance — an error/null probe grants nothing.
      if (result && 'token' in result) {
        recordAssistantAuthIssuance(event.sender.id);
        // Bookkeeping only — NOT the security boundary. Authorization comes
        // from `resolveAssistantAuthOriginRole` re-reading the role registry
        // on every credential resolution, so a destroyed sender (whose role
        // entry is cleared) already stops authorizing without this listener.
        // Guarded because some senders (and test doubles) expose no `once`.
        if (
          typeof event.sender.once === 'function' &&
          !sendersWithDestroyedListener.has(event.sender)
        ) {
          sendersWithDestroyedListener.add(event.sender);
          event.sender.once('destroyed', () => {
            forgetAssistantAuthIssuance(event.sender.id);
          });
        }
      }
      return result;
    }
  );

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
