import type { HostClient } from '@brainstrike/agent-host/client';
import { AGENT_HOST_PROTOCOL_VERSION, HOST_VERSION } from '@brainstrike/agent-host/protocol';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import type { PlatformMessagePort } from './agent-host-platform/connection';
import { type AgentHostPortRelay, openAgentHostChildRelay } from './agent-host-port-relay';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry, settleIpcResult } from './platform/desktop-ipc-registry';

const CONNECT_FAILURE = { category: 'availability', code: 'agent-host-connect-failed' } as const;

/**
 * Visible clients borrow the profile's host; they never start another. Each client's
 * port goes to the host privately, as the desktop origin.
 */
export function registerAgentHostClientIpc(
  acquireProfile: () => Promise<HostClient>,
  openPrivateClientPort: () => PlatformMessagePort | undefined
) {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const relays = new Set<AgentHostPortRelay>();
  // ADR-0031: quit never joins the profile's startup. Close refuses every connect still
  // acquiring the host instead of waiting for it.
  const closed = Promise.withResolvers<false>();
  let closing: Promise<void> | undefined;
  registry.registerAuthorizedInvoke(
    'agent',
    DESKTOP_IPC_CHANNELS.agent.hostConnect,
    { roles: ['visible-ui'] },
    (event, requestId: unknown) => {
      // A refusal (a profile closed for reset or quit) reaches the frame typed.
      return settleIpcResult(CONNECT_FAILURE, async (): Promise<void> => {
        const id = wireDecoder(Schema.String.check(Schema.isUUID()), {
          errors: 'all',
          onExcessProperty: 'error',
        })(requestId);
        if (closing) {
          throw new Error('Agent client bridge is closing');
        }
        const frame = event.senderFrame;
        if (!frame) {
          throw new Error('Agent client has no authorized frame');
        }
        const acquired = await Promise.race([acquireProfile().then(() => true), closed.promise]);
        if (!acquired) {
          throw new Error('Agent client bridge is closing');
        }
        const privatePort = openPrivateClientPort();
        if (!privatePort) {
          throw new Error('The agent host exited before this client connected');
        }
        const relay = openAgentHostChildRelay(privatePort);
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
            {
              host: { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
              requestId: id,
            },
            [relay.port]
          );
        } catch (cause) {
          relay.port.close();
          await relay.close();
          throw cause;
        }
      });
    }
  );
  return {
    close: (): Promise<void> => {
      closing ??= (async () => {
        registry.unregisterAll();
        closed.resolve(false);
        await Promise.all([...relays].map((relay) => relay.close()));
      })();
      return closing;
    },
    unregister: (): void => registry.unregisterAll(),
  };
}
