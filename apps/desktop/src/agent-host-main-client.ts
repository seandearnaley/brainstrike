import { authenticateHostClient, type HostClient } from '@brainstrike/agent-host';
import type { HostMethod, HostParams, HostResults } from '@brainstrike/agent-host/protocol';
import type { HostAttachment } from '@brainstrike/host-lease';
import type { MessagePortMain } from 'electron';
import { mainPlatformConnection } from './agent-host-platform/connection';

export interface AgentHostMainClient {
  close(): Promise<void>;
  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResults[M]>;
}

/**
 * Main's own client of the host this app launched, on a private port: the
 * desktop origin. Settings credential writes, provider sign-in and subscription
 * verification reach the profile's single credential owner through it. A host
 * the app only attached to (a CLI `host start`) hands out no private port, so
 * these requests refuse there.
 */
export function createAgentHostMainClient(
  acquireProfile: () => Promise<HostAttachment>,
  openPrivateClientPort: () => MessagePortMain | undefined
): AgentHostMainClient {
  let current: Promise<HostClient> | undefined;
  const connect = async (): Promise<HostClient> => {
    const attachment = await acquireProfile();
    const port = openPrivateClientPort();
    if (!port) {
      throw new Error(
        'Credentials can change only through the agent host this app launched; stop the external host and retry.'
      );
    }
    const closed = new Promise<void>((resolve) => port.once('close', () => resolve()));
    const connection = mainPlatformConnection(port);
    // A closed port rejects pending requests instead of leaving them unanswered.
    void closed.then(() => connection.dispose());
    return await authenticateHostClient(
      connection,
      attachment.record,
      async () => {
        port.close();
      },
      closed
    );
  };
  const client = (): Promise<HostClient> => {
    if (!current) {
      const next = connect();
      current = next;
      const forget = (): void => {
        if (current === next) {
          current = undefined;
        }
      };
      // A lost host is reconnected on the next request, never replaced mid-call.
      next.then((connected) => connected.closed.then(forget, forget), forget);
    }
    return current;
  };
  return {
    close: async () => {
      const closing = current;
      current = undefined;
      await (await closing?.catch(() => undefined))?.close();
    },
    request: async (method, params) => await (await client()).request(method, params),
  };
}
