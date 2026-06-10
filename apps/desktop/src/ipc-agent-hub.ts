import { type AgentHub, BUILTIN_SESSION_KEY, type HubSnapshot } from '@brainstrike/agent-hub';
import { createLogger } from '@brainstrike/utils';
import type { AgentHubRuntimeConfig } from './agent-hub/agent-hub-config';
import type {
  AgentHubServerManager,
  AgentHubServerStatus,
} from './agent-hub/agent-hub-server-manager';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const logger = createLogger('AgentHubIpc');

/** Hub events within this window collapse into one snapshot broadcast. */
const SNAPSHOT_COALESCE_MS = 100;

interface BroadcastTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

type IpcMainLike = Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'];

export interface RegisterAgentHubIpcHandlersOptions {
  getBroadcastTargets: () => BroadcastTarget[];
  hub: AgentHub;
  ipcMain: IpcMainLike;
  manager: AgentHubServerManager;
}

interface PostMessagePayload {
  channel?: string;
  text: string;
}

function assertPostMessagePayload(value: unknown): PostMessagePayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('post-message payload must be an object.');
  }
  const { channel, text } = value as Record<string, unknown>;
  if (typeof text !== 'string') {
    throw new Error('post-message payload requires a string "text".');
  }
  if (channel !== undefined && typeof channel !== 'string') {
    throw new Error('post-message "channel" must be a string when present.');
  }
  return channel === undefined ? { text } : { channel, text };
}

export function registerAgentHubIpcHandlers(
  options: RegisterAgentHubIpcHandlersOptions
): () => void {
  const { getBroadcastTargets, hub, ipcMain, manager } = options;
  logger.debug('Registering agent hub IPC handlers');
  const registry = createDesktopIpcRegistry({ ipcMain });
  const channels = DESKTOP_IPC_CHANNELS.agentHub;

  function broadcast(channel: string, payload: HubSnapshot | AgentHubServerStatus): void {
    for (const target of getBroadcastTargets()) {
      if (!target.isDestroyed()) {
        target.send(channel, payload);
      }
    }
  }

  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSnapshotBroadcast(): void {
    if (snapshotTimer) {
      return;
    }
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      broadcast(channels.snapshotEvent, hub.getSnapshot());
    }, SNAPSHOT_COALESCE_MS);
  }

  const hubUnsubscribes = [
    hub.on('agent-joined', scheduleSnapshotBroadcast),
    hub.on('agent-left', scheduleSnapshotBroadcast),
    hub.on('agent-updated', scheduleSnapshotBroadcast),
    hub.on('message-posted', scheduleSnapshotBroadcast),
  ];
  const unsubscribeStatus = manager.onStatusChange((status) => {
    broadcast(channels.statusEvent, status);
  });

  registry.registerInvoke('agent-hub', channels.getStatus, () => manager.getStatus());
  registry.registerInvoke('agent-hub', channels.getSnapshot, () => hub.getSnapshot());
  registry.registerInvoke('agent-hub', channels.start, () => manager.start());
  registry.registerInvoke('agent-hub', channels.stop, async () => {
    await manager.stop();
    return manager.getStatus();
  });
  registry.registerInvoke('agent-hub', channels.applyConfig, (_event, config: unknown) =>
    manager.applyConfig(config as AgentHubRuntimeConfig)
  );
  registry.registerInvoke('agent-hub', channels.postMessage, (_event, payload: unknown) => {
    const { channel, text } = assertPostMessagePayload(payload);
    hub.postMessage({
      sessionKey: BUILTIN_SESSION_KEY,
      text,
      ...(channel === undefined ? {} : { channel }),
    });
  });

  return () => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    for (const unsubscribe of hubUnsubscribes) {
      unsubscribe();
    }
    unsubscribeStatus();
    registry.unregisterAll();
  };
}
