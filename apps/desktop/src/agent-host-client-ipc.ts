import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
import type { HostAttachment, HostRecord } from '@brainstrike/host-lease';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import type { AgentHostPrivateClientPort } from './agent-host-private-clients';
import { type AgentHostSocketRelay, openAgentHostSocketRelay } from './agent-host-socket-relay';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { pushToFrame } from './platform/desktop-ipc-push';
import { createDesktopIpcRegistry, settleIpcResult } from './platform/desktop-ipc-registry';

const CONNECT_FAILURE = { category: 'availability', code: 'agent-host-connect-failed' } as const;

/**
 * Visible clients borrow the profile's existing lease; they never acquire another root.
 * Which transport a frame gets depends only on who launched the host (host-lease.md):
 * - The host this app launched: the frame holds one end of a private channel and the host
 *   the other, admitted as the desktop origin (ADR-0029). Main forwards nothing.
 * - A host the app only attached to (a CLI `host start`): Main relays the frame over that
 *   host's public socket, like any CLI client, so origin-bound capabilities refuse there.
 * A launched host that is gone is never reached over the socket: its frames are refused as
 * unavailable until the profile admits its replacement. Either way the frame owns its port,
 * which closes with the frame's document, and Main tells the frame when the host is gone.
 */
export function registerAgentHostClientIpc(
  acquireProfile: () => Promise<HostAttachment>,
  openPrivateClientPort: (record: HostRecord) => AgentHostPrivateClientPort | undefined
) {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const relays = new Set<AgentHostSocketRelay>();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const openFramePort = async (
    record: HostRecord
  ): Promise<AgentHostPrivateClientPort & { readonly relay?: AgentHostSocketRelay }> => {
    const direct = openPrivateClientPort(record);
    if (direct) {
      return direct;
    }
    const relay = await openAgentHostSocketRelay(record);
    return { hostGone: relay.closed, port: relay.port, relay };
  };
  registry.handle(
    'agent',
    DESKTOP_IPC_CHANNELS.agent.hostConnect,
    Schema.Tuple([Schema.String.check(Schema.isUUID())]),
    (event, id) => {
      const operation = (async (): Promise<void> => {
        if (closing) {
          throw new Error('Agent client bridge is closing');
        }
        const frame = event.senderFrame;
        if (!frame) {
          throw new Error('Agent client has no authorized frame');
        }
        const attachment = await acquireProfile();
        if (attachment.record.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
          throw new Error('The current profile host does not support assistant commands');
        }
        const { hostGone, port, relay } = await openFramePort(attachment.record);
        try {
          if (closing || event.sender.isDestroyed()) {
            throw new Error('Agent client closed during attach');
          }
          pushToFrame(
            frame,
            DESKTOP_IPC_CHANNELS.agent.hostConnected,
            { record: attachment.record, requestId: id },
            [port]
          );
        } catch (cause) {
          port.close();
          await relay?.close();
          throw cause;
        }
        if (relay) {
          relays.add(relay);
          void relay.closed.then(() => relays.delete(relay));
        }
        void hostGone.then(() => {
          if (event.sender.isDestroyed()) {
            return;
          }
          try {
            // A later document of this frame ignores a request id it never sent.
            pushToFrame(frame, DESKTOP_IPC_CHANNELS.agent.hostDisconnected, { requestId: id });
          } catch {
            /* A detached frame already lost its port with its document. */
          }
        });
      })();
      pending.add(operation);
      operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation)
      );
      // A refusal (a profile closed for reset or quit) reaches the frame typed.
      return settleIpcResult(CONNECT_FAILURE, () => operation);
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
