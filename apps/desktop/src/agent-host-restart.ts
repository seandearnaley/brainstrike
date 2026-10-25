/**
 * Restarts the agent host this app launched (BST-1880): ask, grace, kill, as any
 * close of it. That exit is the recovery a lost host already takes (BST-2004):
 * the next acquisition starts a new host.
 */
export async function restartLaunchedAgentHost(options: {
  readonly acquireProfile: () => Promise<unknown>;
  readonly logger: { info(message: string): void };
  /** Ends the live host and joins its exit; undefined when none is running. */
  readonly stopLaunchedHost: () => Promise<number> | undefined;
}): Promise<void> {
  options.logger.info('Restarting the agent host at the user’s request');
  await options.stopLaunchedHost();
  // Relaunched here, after the exit: a client reconnecting afterwards reaches the
  // new host, and a failed relaunch is this call's own visible failure.
  await options.acquireProfile();
}
