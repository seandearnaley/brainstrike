import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { canonicalRoot } from '@brainstrike/state-store';
import { HostCliExitError } from './cli-session.ts';
import type { HostClient } from './client.ts';

export interface CliWorkspaceTrustOptions {
  readonly interactive: boolean;
  /** The standalone root to trust; the current directory when omitted. */
  readonly root?: string | undefined;
  /** The person confirmed on the command line; trusting without a terminal requires it. */
  readonly yes?: boolean | undefined;
}

/**
 * `workspace trust` (ADR-0032): a standalone host loads a launch root's agent
 * configuration (its subagent personas) only once the person trusts it. The
 * prompt names the folder by the canonical path the host keys trust by.
 * Desktop folders are trusted from the composer or Settings › Workspace trust.
 */
export async function trustCliWorkspace(
  client: Pick<HostClient, 'request'>,
  options: CliWorkspaceTrustOptions
): Promise<{ readonly path: string; readonly trust: 'trusted' }> {
  const path = canonicalRoot(resolve(options.root ?? process.cwd()));
  if (!options.yes) {
    await confirmWorkspaceTrust(path, options.interactive);
  }
  await client.request('workspace/trust', { path, trust: 'trusted' });
  return { path, trust: 'trusted' };
}

/** Only an explicit yes trusts a folder. */
async function confirmWorkspaceTrust(path: string, interactive: boolean): Promise<void> {
  if (!interactive) {
    throw new HostCliExitError(`Review ${path}, then trust it with --yes`, 2);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(
      `Trust the files in ${path}? Brainstrike will load its agent configuration. [y/N] `
    );
    if (!/^y(es)?$/iu.test(answer.trim())) {
      throw new HostCliExitError('The folder was not trusted', 1);
    }
  } finally {
    terminal.close();
  }
}
