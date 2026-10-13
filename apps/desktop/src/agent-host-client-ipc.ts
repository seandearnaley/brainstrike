import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
import type { HostAttachment } from '@brainstrike/host-lease';
import { ipcMain, type MessagePortMain } from 'electron';
import { z } from 'zod';
import {
  type AgentHostPortRelay,
  openAgentHostChildRelay,
  openAgentHostPortRelay,
} from './agent-host-port-relay';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

function profileAcquireOptions(intent: unknown): { readonly reconnect: true } | undefined {
  const action = z.literal('reconnect').optional().parse(intent);
  return action === 'reconnect' ? { reconnect: true } : undefined;
}

/**
 * Visible clients borrow the profile's existing lease; they never acquire another root.
 * A host this app launched receives each client port privately, as the desktop
 * origin. A host the app only attached to (a CLI `host start`) is reached over its
 * public socket like any CLI client, so origin-bound capabilities refuse there.
 */
export function registerAgentHostClientIpc(
  acquireProfile: (options?: { readonly reconnect: true }) => Promise<HostAttachment>,
  openPrivateClientPort: () => MessagePortMain | undefined
) {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const relays = new Set<AgentHostPortRelay>();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  registry.registerAuthorizedInvoke(
    'agent',
    DESKTOP_IPC_CHANNELS.agent.hostConnect,
    { roles: ['visible-ui'] },
    (event, requestId: unknown, intent: unknown) => {
      const operation = (async (): Promise<void> => {
        const id = z.string().uuid().parse(requestId);
        if (closing) {
          throw new Error('Agent client bridge is closing');
        }
        const frame = event.senderFrame;
        if (!frame) {
          throw new Error('Agent client has no authorized frame');
        }
        const attachment = await acquireProfile(profileAcquireOptions(intent));
        if (attachment.record.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
          throw new Error('The current profile host does not support assistant commands');
        }
        const privatePort = openPrivateClientPort();
        const relay = privatePort
          ? openAgentHostChildRelay(privatePort)
          : await openAgentHostPortRelay(attachment.record);
        relays.add(relay);
        let clientGone = false;
        const retire = (): void => {
          clientGone = true;
          void relay.close();
        };
        event.sender.once('destroyed', retire);
        event.sender.once('render-process-gone', retire);
        event.sender.once('did-navigate', retire);
        void relay.closed.then(() => {
          relays.delete(relay);
          event.sender.off('destroyed', retire);
          event.sender.off('render-process-gone', retire);
          event.sender.off('did-navigate', retire);
          if (!(clientGone || event.sender.isDestroyed())) {
            try {
              frame.postMessage(DESKTOP_IPC_CHANNELS.agent.hostDisconnected, { requestId: id });
            } catch {
              /* A detached frame already lost its transport. */
            }
          }
        });
        try {
          if (closing || event.sender.isDestroyed()) {
            throw new Error('Agent client closed during attach');
          }
          frame.postMessage(
            DESKTOP_IPC_CHANNELS.agent.hostConnected,
            { record: attachment.record, requestId: id },
            [relay.port]
          );
        } catch (cause) {
          relay.port.close();
          await relay.close();
          throw cause;
        }
      })();
      pending.add(operation);
      operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation)
      );
      return operation;
    }
  );
  return {
    close: (): Promise<void> => {
      closing ??= (async () => {
        registry.unregisterAll();
        await Promise.allSettled([...pending]);
        await Promise.all([...relays].map((relay) => relay.close()));
      })();
      return closing;
    },
    unregister: (): void => registry.unregisterAll(),
  };
}
