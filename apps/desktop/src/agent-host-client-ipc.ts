import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
import type { HostAttachment } from '@brainstrike/host-lease';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import type { AgentHostPrivateClientPort } from './agent-host-private-clients';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { pushToFrame } from './platform/desktop-ipc-push';
import { createDesktopIpcRegistry, settleIpcResult } from './platform/desktop-ipc-registry';

const CONNECT_FAILURE = { category: 'availability', code: 'agent-host-connect-failed' } as const;

/**
 * Visible clients borrow the profile's existing lease; they never acquire another root.
 * Each authorized frame gets one end of a channel whose other end the host this app
 * launched received privately, as the desktop origin (ADR-0029): the frame and the host
 * talk directly, and Main forwards nothing. Chromium closes the frame's end when its
 * document goes (reload, navigation, renderer loss), which closes the host's end. A host
 * the app only attached to (a CLI `host start`) hands out no private port, so the frame
 * is refused there.
 */
export function registerAgentHostClientIpc(
  acquireProfile: () => Promise<HostAttachment>,
  openPrivateClientPort: () => AgentHostPrivateClientPort | undefined
) {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
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
        const client = openPrivateClientPort();
        if (!client) {
          throw new Error(
            'The assistant runs only on the agent host this app launched; stop the external host and retry.'
          );
        }
        const { sender } = event;
        try {
          if (closing || sender.isDestroyed()) {
            throw new Error('Agent client closed during attach');
          }
          pushToFrame(
            frame,
            DESKTOP_IPC_CHANNELS.agent.hostConnected,
            { record: attachment.record, requestId: id },
            [client.port]
          );
        } catch (cause) {
          client.port.close();
          throw cause;
        }
        // Main holds neither end now. It still sees the host exit, and tells this
        // document so it connects again through this same call.
        let attached = true;
        const detach = (): void => {
          attached = false;
          sender.off('destroyed', detach);
          sender.off('render-process-gone', detach);
          sender.off('did-navigate', detach);
        };
        sender.once('destroyed', detach);
        sender.once('render-process-gone', detach);
        sender.once('did-navigate', detach);
        void client.hostExited.then(() => {
          if (!attached || sender.isDestroyed()) {
            return;
          }
          detach();
          try {
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
      })();
      return closing;
    },
    unregister: (): void => registry.unregisterAll(),
  };
}
