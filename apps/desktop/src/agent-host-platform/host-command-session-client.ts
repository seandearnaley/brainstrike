import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
/**
 * Main's view of the live agent host's command sessions, over the platform
 * connection Main serves. Attached when the host connects and dropped when it
 * closes; the Terminal panel merges it with Main's own sessions.
 */

import type { MessageConnection } from 'vscode-jsonrpc';
import { disposeDesktopCommandSessionsForRoot } from '../assistant-server/command-session-manager';
import {
  HostCommandSessionDisposeRootResultSchema,
  HostCommandSessionDoneResultSchema,
  type HostCommandSessionIdentitySchema,
  type HostCommandSessionListRequestSchema,
  HostCommandSessionListResultSchema,
  type HostCommandSessionReadRequestSchema,
  HostCommandSessionReadResultSchema,
  type HostCommandSessionWriteRequestSchema,
} from './command-session-wire';

export interface HostCommandSessionClient {
  readonly disposeRoot: (rootId: string) => Promise<number>;
  readonly list: (
    params: (typeof HostCommandSessionListRequestSchema)['Encoded']
  ) => Promise<(typeof HostCommandSessionListResultSchema)['Type']>;
  readonly read: (
    params: (typeof HostCommandSessionReadRequestSchema)['Encoded']
  ) => Promise<(typeof HostCommandSessionReadResultSchema)['Type']>;
  readonly remove: (
    params: (typeof HostCommandSessionIdentitySchema)['Encoded']
  ) => Promise<(typeof HostCommandSessionDoneResultSchema)['Type']>;
  readonly stop: (
    params: (typeof HostCommandSessionIdentitySchema)['Encoded']
  ) => Promise<(typeof HostCommandSessionDoneResultSchema)['Type']>;
  readonly write: (
    params: (typeof HostCommandSessionWriteRequestSchema)['Encoded']
  ) => Promise<(typeof HostCommandSessionDoneResultSchema)['Type']>;
}

let attached: HostCommandSessionClient | undefined;

/** The connected host's command sessions, or undefined while no host is connected. */
export function hostCommandSessions(): HostCommandSessionClient | undefined {
  return attached;
}

export function attachHostCommandSessions(connection: MessageConnection): void {
  const client: HostCommandSessionClient = {
    disposeRoot: async (rootId) =>
      wireDecoder(HostCommandSessionDisposeRootResultSchema, { errors: 'all' })(
        await connection.sendRequest('host/command-sessions/dispose-root', { rootId })
      ).disposed,
    list: async (params) =>
      wireDecoder(HostCommandSessionListResultSchema, { errors: 'all' })(
        await connection.sendRequest('host/command-sessions/list', params)
      ),
    read: async (params) =>
      wireDecoder(HostCommandSessionReadResultSchema, { errors: 'all' })(
        await connection.sendRequest('host/command-sessions/read', params)
      ),
    remove: async (params) =>
      wireDecoder(HostCommandSessionDoneResultSchema, { errors: 'all' })(
        await connection.sendRequest('host/command-sessions/remove', params)
      ),
    stop: async (params) =>
      wireDecoder(HostCommandSessionDoneResultSchema, { errors: 'all' })(
        await connection.sendRequest('host/command-sessions/stop', params)
      ),
    write: async (params) =>
      wireDecoder(HostCommandSessionDoneResultSchema, { errors: 'all' })(
        await connection.sendRequest('host/command-sessions/write', params)
      ),
  };
  attached = client;
  connection.onClose(() => {
    if (attached === client) {
      attached = undefined;
    }
  });
}

/**
 * A disconnected root's command sessions: Main's own, then the connected
 * agent host's, as legacy disconnect stopped every session in the root.
 */
export async function disposeDesktopAndHostCommandSessionsForRoot(rootId: string): Promise<number> {
  const main = await disposeDesktopCommandSessionsForRoot(rootId);
  const host = attached ? await attached.disposeRoot(rootId) : 0;
  return main + host;
}
