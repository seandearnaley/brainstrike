import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import type { HostAttachment } from '@brainstrike/host-lease';

/**
 * Restarts the agent host this app launched (BST-1880). The lease asks its own
 * child to close over the child's control port and joins the exit under its one
 * close ladder (ADR-0026 R5(b)): cooperative close, then `kill()` after
 * `CHILD_CLOSE_BUDGET_MS`, then the exit. No clock refuses a restart
 * because the machine is slow. That exit is the recovery a lost host already
 * takes (BST-2004): the profile acquisition joins the release, resumes native
 * indexing and admits the new host. A host started from the CLI is never
 * stopped from here.
 */
export async function restartLaunchedAgentHost(options: {
  readonly acquireProfile: () => Promise<HostAttachment>;
  readonly logger: { info(message: string): void };
  /** Stops the live host this app launched and joins its exit; undefined when there is none. */
  readonly stopLaunchedHost: () => Promise<number> | undefined;
}): Promise<void> {
  const stopped = options.stopLaunchedHost();
  if (!stopped) {
    throw refusalError(
      'conflict',
      'agent-host.restart.external',
      'The agent host was started outside Brainstrike, so it was not restarted.',
      'Restart it where it was started, for example with `brainstrike host stop`.'
    );
  }
  options.logger.info('Restarting the agent host at the user’s request');
  await stopped;
  // Relaunched here, after the joined exit: a client reconnecting afterwards
  // reaches the new host, and a failed relaunch is this call's own visible failure.
  await options.acquireProfile();
}
