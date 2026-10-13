import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
import type { HostAttachment } from '@brainstrike/host-lease';
import { ipcMain, type MessagePortMain } from 'electron';
import { z } from 'zod';
import { retiredAgentAttachment } from './agent-host-attachment';
import {
  type AgentHostPortRelay,
  openAgentHostChildRelay,
  openAgentHostPortRelay,
} from './agent-host-port-relay';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry, settleIpcResult } from './platform/desktop-ipc-registry';

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
  acquireProfile: (
    options: { readonly reconnect: true } | undefined,
    signal: AbortSignal
  ) => Promise<HostAttachment>,
  openPrivateClientPort: () => MessagePortMain | undefined
) {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const relays = new Set<AgentHostPortRelay>();
  const pending = new Set<{
    readonly cancellation: AbortController;
    readonly operation: Promise<void>;
  }>();
  let closing: Promise<void> | undefined;
  registry.registerAuthorizedInvoke(
    'agent',
    DESKTOP_IPC_CHANNELS.agent.hostConnect,
    { roles: ['visible-ui'] },
    (event, requestId: unknown, intent: unknown) => {
      const cancellation = new AbortController();
      const retire = (): void => cancellation.abort(retiredAgentAttachment());
      const detach = (): void => {
        event.sender.off('destroyed', retire);
        event.sender.off('render-process-gone', retire);
        event.sender.off('did-navigate', retire);
      };
      event.sender.once('destroyed', retire);
      event.sender.once('render-process-gone', retire);
      event.sender.once('did-navigate', retire);
      let relay: AgentHostPortRelay | undefined;
      const operation = (async (): Promise<void> => {
        const id = z.string().uuid().parse(requestId);
        if (closing || event.sender.isDestroyed()) {
          retire();
        }
        cancellation.signal.throwIfAborted();
        const frame = event.senderFrame;
        if (!frame) {
          throw new Error('Agent client has no authorized frame');
        }
        const attachment = await acquireProfile(profileAcquireOptions(intent), cancellation.signal);
        cancellation.signal.throwIfAborted();
        if (attachment.record.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
          throw new Error('The current profile host does not support assistant commands');
        }
        const privatePort = openPrivateClientPort();
        const transport = privatePort
          ? openAgentHostChildRelay(privatePort)
          : await openAgentHostPortRelay(attachment.record);
        let release: Promise<void> | undefined;
        const owned: AgentHostPortRelay = {
          ...transport,
          close: () =>
            (release ??= (async () => {
              const outcomes = await Promise.allSettled([
                (async () => transport.close())(),
                transport.closed,
              ]);
              const failures = outcomes.flatMap((outcome) =>
                outcome.status === 'rejected' ? [outcome.reason] : []
              );
              if (failures.length === 1) {
                throw failures[0];
              }
              if (failures.length > 1) {
                throw new AggregateError(failures, 'Agent relay physical retirement failed');
              }
            })()),
        };
        relay = owned;
        relays.add(owned);
        const closeOnRetirement = (): void => {
          // The same owned close is joined by close() below. A failure keeps
          // this relay in the set even when its physical exit has arrived.
          void owned.close().catch(() => undefined);
        };
        cancellation.signal.addEventListener('abort', closeOnRetirement, { once: true });
        void owned.closed.then(async () => {
          try {
            await release;
            relays.delete(owned);
          } catch {
            // Retain the same release and its cause for the owner join.
          }
          cancellation.signal.removeEventListener('abort', closeOnRetirement);
          detach();
          if (!(cancellation.signal.aborted || event.sender.isDestroyed())) {
            try {
              frame.postMessage(DESKTOP_IPC_CHANNELS.agent.hostDisconnected, { requestId: id });
            } catch {
              /* A detached frame already lost its transport. */
            }
          }
        });
        try {
          cancellation.signal.throwIfAborted();
          frame.postMessage(
            DESKTOP_IPC_CHANNELS.agent.hostConnected,
            { record: attachment.record, requestId: id },
            [owned.port]
          );
        } catch (cause) {
          owned.port.close();
          try {
            await owned.close();
          } catch (cleanup) {
            throw new AggregateError(
              [cause, cleanup],
              'Agent attachment and relay retirement failed'
            );
          }
          throw cause;
        }
      })().finally(() => {
        if (!relay) {
          detach();
        }
      });
      const entry = { cancellation, operation };
      pending.add(entry);
      operation.then(
        () => pending.delete(entry),
        () => pending.delete(entry)
      );
      return settleIpcResult(
        { category: 'agent', code: DESKTOP_IPC_CHANNELS.agent.hostConnect },
        () => operation
      );
    }
  );
  return {
    close: (): Promise<void> => {
      closing ??= (async () => {
        registry.unregisterAll();
        const attaching = [...pending];
        for (const entry of attaching) {
          entry.cancellation.abort(retiredAgentAttachment());
        }
        const settled = await Promise.allSettled(attaching.map((entry) => entry.operation));
        const failures = settled.flatMap((outcome, index) =>
          outcome.status === 'rejected' &&
          outcome.reason !== attaching[index]?.cancellation.signal.reason
            ? [outcome.reason]
            : []
        );
        const releases = await Promise.allSettled([...relays].map((owned) => owned.close()));
        failures.push(
          ...releases.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []))
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Agent client retirement failed');
        }
      })();
      return closing;
    },
    unregister: (): void => registry.unregisterAll(),
  };
}
