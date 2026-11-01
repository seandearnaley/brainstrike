import {
  disposeLiveChildProcesses,
  disposeLspServers,
} from '@brainstrike/host-capabilities/native-tools';
/**
 * The desktop agent host's process-lifetime tool state: the command sessions
 * its runs start, and the disposal of
 * every process-owned tool resource when the host closes. Runs in the host only.
 */
import {
  type CommandSessionManager,
  createCommandSessionManager,
} from '../assistant-server/command-session-manager';

let sessions: CommandSessionManager | undefined;

/** This host's command sessions. It has no root resolver: each start names its run's roots. */
export function hostCommandSessionManager(): CommandSessionManager {
  sessions ??= createCommandSessionManager({});
  return sessions;
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
