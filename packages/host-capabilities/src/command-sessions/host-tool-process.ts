/**
 * An agent host's process-lifetime tool state (desktop and standalone): the
 * command sessions its runs start, and the disposal of every process-owned tool
 * resource when the host closes.
 */
import { disposeLiveChildProcesses } from '../native-tools/execute-command-tool.ts';
import { disposeLspServers } from '../native-tools/lsp-diagnostics.ts';
import {
  type CommandSessionManager,
  createCommandSessionManager,
} from './command-session-manager.ts';

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
