import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import {
  disposeLiveChildProcesses,
  disposeLspServers,
  evictLspServersForRoot,
} from '@brainstrike/host-capabilities/native-tools';
/**
 * The desktop agent host's process-lifetime tool state: the command sessions
 * its runs start, the release of a root Main disconnected, and the disposal of
 * every process-owned tool resource when the host closes. Runs in the host only.
 */
import type { MessageConnection } from 'vscode-jsonrpc';
import {
  type CommandSessionManager,
  createCommandSessionManager,
} from '../assistant-server/command-session-manager';
import { HostRootCleanupRequestSchema } from './root-cleanup-wire';

let sessions: CommandSessionManager | undefined;

/** This host's command sessions. It has no root resolver: each start names its run's roots. */
export function hostCommandSessionManager(): CommandSessionManager {
  sessions ??= createCommandSessionManager({});
  return sessions;
}

const decodeRoot = wireDecoder(HostRootCleanupRequestSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});

/** A root disconnected in Main stops this host's sessions and language servers there. */
export function serveHostRootCleanup(connection: MessageConnection): void {
  connection.onRequest(
    'host/command-sessions/dispose-root',
    async (input: unknown): Promise<unknown> => ({
      disposed: await hostCommandSessionManager().disposeRoot(decodeRoot(input).rootId),
    })
  );
  connection.onRequest('host/lsp/evict-root', async (input: unknown): Promise<unknown> => {
    await evictLspServersForRoot(decodeRoot(input).rootId);
    return null;
  });
}

/** The language servers, command trees and command sessions this host spawned. */
export async function disposeHostTools(): Promise<void> {
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(disposeLspServers),
    Promise.resolve().then(disposeLiveChildProcesses),
    Promise.resolve().then(() => sessions?.dispose()),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Host tool cleanup failed');
  }
}
