/**
 * Main's view of the live agent host's command sessions, over the platform
 * connection Main serves. Attached when the host connects and dropped when it
 * closes; the Terminal panel merges it with Main's own sessions.
 */

import type { MessageConnection } from 'vscode-jsonrpc';
import type { z } from 'zod';
import {
  HostCommandSessionDoneResultSchema,
  type HostCommandSessionIdentitySchema,
  type HostCommandSessionListRequestSchema,
  HostCommandSessionListResultSchema,
  type HostCommandSessionReadRequestSchema,
  HostCommandSessionReadResultSchema,
  type HostCommandSessionWriteRequestSchema,
} from './command-session-wire';

export interface HostCommandSessionClient {
  readonly list: (
    params: z.input<typeof HostCommandSessionListRequestSchema>
  ) => Promise<z.output<typeof HostCommandSessionListResultSchema>>;
  readonly read: (
    params: z.input<typeof HostCommandSessionReadRequestSchema>
  ) => Promise<z.output<typeof HostCommandSessionReadResultSchema>>;
  readonly remove: (
    params: z.input<typeof HostCommandSessionIdentitySchema>
  ) => Promise<z.output<typeof HostCommandSessionDoneResultSchema>>;
  readonly stop: (
    params: z.input<typeof HostCommandSessionIdentitySchema>
  ) => Promise<z.output<typeof HostCommandSessionDoneResultSchema>>;
  readonly write: (
    params: z.input<typeof HostCommandSessionWriteRequestSchema>
  ) => Promise<z.output<typeof HostCommandSessionDoneResultSchema>>;
}

let attached: HostCommandSessionClient | undefined;

/** The connected host's command sessions, or undefined while no host is connected. */
export function hostCommandSessions(): HostCommandSessionClient | undefined {
  return attached;
}

export function attachHostCommandSessions(connection: MessageConnection): void {
  const client: HostCommandSessionClient = {
    list: async (params) =>
      HostCommandSessionListResultSchema.parse(
        await connection.sendRequest('host/command-sessions/list', params)
      ),
    read: async (params) =>
      HostCommandSessionReadResultSchema.parse(
        await connection.sendRequest('host/command-sessions/read', params)
      ),
    remove: async (params) =>
      HostCommandSessionDoneResultSchema.parse(
        await connection.sendRequest('host/command-sessions/remove', params)
      ),
    stop: async (params) =>
      HostCommandSessionDoneResultSchema.parse(
        await connection.sendRequest('host/command-sessions/stop', params)
      ),
    write: async (params) =>
      HostCommandSessionDoneResultSchema.parse(
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
