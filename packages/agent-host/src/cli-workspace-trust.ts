import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { canonicalRoot } from '@brainstrike/state-store';
import { HostCliExitError } from './cli-session.ts';
import type { HostClient } from './client.ts';

export interface CliWorkspaceTrustOptions {
  readonly interactive: boolean;
  /** The standalone root to trust; the current directory when omitted. */
  readonly root?: string | undefined;
  /**
   * `--trust-parent`: also record the root's parent as a trusted location, so
   * every folder in it is trusted without an ask. Never implied by anything else.
   */
  readonly trustParent?: boolean | undefined;
  /** The person confirmed on the command line; trusting without a terminal requires it. */
  readonly yes?: boolean | undefined;
}

/**
 * `workspace trust` (ADR-0032): a standalone host loads a launch root's agent
 * configuration (its instructions file, skills and personas) only once the person trusts it. The
 * prompt names the folder by the canonical path the host keys trust by, and,
 * with `--trust-parent`, the parent that becomes a trusted location. The host
 * refuses a parent it does not offer: the top of the filesystem, the home
 * directory or a folder that holds it.
 * Desktop folders are trusted from the composer or Settings › Workspace Trust.
 */
export async function trustCliWorkspace(
  client: Pick<HostClient, 'request'>,
  options: CliWorkspaceTrustOptions
): Promise<{ readonly location?: string; readonly path: string; readonly trust: 'trusted' }> {
  const path = canonicalRoot(resolve(options.root ?? process.cwd()));
  const location = options.trustParent ? dirname(path) : undefined;
  if (!options.yes) {
    await confirmWorkspaceTrust(path, location, options.interactive);
  }
  await client.request('workspace/trust', {
    ...(location === undefined ? {} : { location }),
    path,
    trust: 'trusted',
  });
  return { ...(location === undefined ? {} : { location }), path, trust: 'trusted' };
}

/** Only an explicit yes trusts a folder, or every folder in its parent. */
async function confirmWorkspaceTrust(
  path: string,
  location: string | undefined,
  interactive: boolean
): Promise<void> {
  if (!interactive) {
    throw new HostCliExitError(
      location === undefined
        ? `Review ${path}, then trust it with --yes`
        : `Review ${path} and every folder in ${location}, then trust them with --yes --trust-parent`,
      2
    );
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(
      location === undefined
        ? `Trust the files in ${path}? Brainstrike will load its agent configuration. [y/N] `
        : `Trust the files in ${path}, and every folder in ${location}, now and later? Brainstrike will load their agent configuration without asking. [y/N] `
    );
    if (!/^y(es)?$/iu.test(answer.trim())) {
      throw new HostCliExitError('The folder was not trusted', 1);
    }
  } finally {
    terminal.close();
  }
}
