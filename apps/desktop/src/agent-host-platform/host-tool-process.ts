/**
 * The desktop agent host's process-lifetime tool state: the command sessions
 * its runs start, served to Main's Terminal panel over the platform
 * connection, and the disposal of every process-owned tool resource when the
 * host closes. Runs in the host only.
 */
import type { MessageConnection } from 'vscode-jsonrpc';
import {
  type CommandSessionManager,
  createCommandSessionManager,
} from '../assistant-server/command-session-manager';
import { disposeLiveChildProcesses } from '../assistant-server/execute-command-tool';
import { disposeLspServers } from '../assistant-server/lsp-diagnostics';
import { createCommandSessionIpcHandlers } from '../command-session-ipc-handlers';
import {
  HostCommandSessionIdentitySchema,
  HostCommandSessionListRequestSchema,
  HostCommandSessionReadRequestSchema,
  HostCommandSessionWriteRequestSchema,
} from './command-session-wire';

let sessions: CommandSessionManager | undefined;

/** This host's command sessions. It has no root resolver: each start names its run's roots. */
export function hostCommandSessionManager(): CommandSessionManager {
  sessions ??= createCommandSessionManager({});
  return sessions;
}

/**
 * Main's Terminal panel lists, reads, writes, stops and removes this host's
 * sessions; each reply crosses as JSON that Main parses.
 */
export function serveHostCommandSessions(connection: MessageConnection): void {
  const handlers = createCommandSessionIpcHandlers({ manager: hostCommandSessionManager() });
  connection.onRequest('host/command-sessions/list', (input: unknown): unknown =>
    handlers.list(HostCommandSessionListRequestSchema.parse(input))
  );
  connection.onRequest('host/command-sessions/read', (input: unknown): unknown =>
    handlers.read(HostCommandSessionReadRequestSchema.parse(input))
  );
  connection.onRequest('host/command-sessions/write', (input: unknown): unknown =>
    handlers.write(HostCommandSessionWriteRequestSchema.parse(input))
  );
  connection.onRequest('host/command-sessions/stop', (input: unknown): unknown =>
    handlers.stop(HostCommandSessionIdentitySchema.parse(input))
  );
  connection.onRequest('host/command-sessions/remove', (input: unknown): unknown =>
    handlers.remove(HostCommandSessionIdentitySchema.parse(input))
  );
  // A root disconnected in Main stops and forgets this host's sessions there.
  connection.onRequest(
    'host/command-sessions/dispose-root',
    async (input: unknown): Promise<unknown> => {
      const { rootId } = HostCommandSessionListRequestSchema.parse(input);
      return { disposed: await hostCommandSessionManager().disposeRoot(rootId) };
    }
  );
}

/** The language servers, command trees and command sessions this host spawned. */
export async function disposeHostTools(): Promise<void> {
  await disposeLspServers();
  disposeLiveChildProcesses();
  await sessions?.dispose();
}
