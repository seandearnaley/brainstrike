import { attachAgentHost } from '@brainstrike/agent-host/client';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { runWithTimeout } from '@brainstrike/effect-kit';
import type { HostAttachment } from '@brainstrike/host-lease';

/**
 * Restarts the agent host this app launched (BST-1880). It asks the host to
 * stop over its own socket, where `host/stop` has the host's lifecycle; the
 * host releases its Root and exits. The relaunch is the recovery a lost host
 * already takes (BST-2004): the profile acquisition joins the release, resumes
 * native indexing and admits the new host. A host started from the CLI is
 * never stopped from here.
 */
export async function restartLaunchedAgentHost(options: {
  readonly acquireProfile: () => Promise<HostAttachment>;
  /** The launched host's exit; undefined when the live host is not one this app launched. */
  readonly exited: () => Promise<number> | undefined;
  readonly logger: { info(message: string): void };
  readonly exitTimeoutMs?: number;
}): Promise<void> {
  const exited = options.exited();
  if (!exited) {
    throw refusalError(
      'conflict',
      'agent-host.restart.external',
      'The agent host was started outside BrainStrike, so it was not restarted.',
      'Restart it where it was started, for example with `brainstrike host stop`.'
    );
  }
  const attachment = await options.acquireProfile();
  const client = await attachAgentHost(attachment.record);
  try {
    options.logger.info('Restarting the agent host at the user’s request');
    await client.request('host/stop', {});
  } finally {
    await client.close().catch(() => undefined);
  }
  // The host closes its clients before its process exits. Wait for Main to see
  // the exit, then relaunch here: the profile acquisition runs the lost-host
  // recovery and admits the next host, so a client reconnecting afterwards
  // reaches it, and a failed relaunch is this call's own visible failure.
  await runWithTimeout(() => exited, {
    onTimeout: () => new Error('The agent host stopped but did not exit.'),
    timeoutMs: options.exitTimeoutMs ?? 10_000,
  });
  await options.acquireProfile();
}
