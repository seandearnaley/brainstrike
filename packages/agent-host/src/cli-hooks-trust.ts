import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { HostCliExitError } from './cli-session.js';
import type { HostClient } from './client.js';
import { hostProjectHooksPath } from './hook-trust.js';

export interface CliHooksTrustOptions {
  readonly interactive: boolean;
  /** The standalone root to trust; the current directory when omitted. */
  readonly root?: string | undefined;
  /** The reviewed hash; trusting without a terminal requires it. */
  readonly sha256?: string | undefined;
}

/**
 * `hooks trust`: a standalone host names each launch root by its real path,
 * which is also the root's ID. The reviewer confirms the file's hash, and the
 * host re-hashes the file and trusts only those exact bytes. Desktop roots are
 * approved in Settings › Hooks.
 */
export async function trustCliProjectHooks(
  client: Pick<HostClient, 'request'>,
  options: CliHooksTrustOptions
): Promise<{ readonly rootId: string; readonly sha256: string; readonly trusted: true }> {
  const rootId = await realpath(options.root ?? process.cwd());
  const sha256 = options.sha256 ?? (await reviewProjectHooks(rootId, options.interactive));
  await client.request('hooks/trust', { path: rootId, rootId, sha256 });
  return { rootId, sha256, trusted: true };
}

/** The file and its hash for the reviewer; only an explicit yes trusts it. */
async function reviewProjectHooks(root: string, interactive: boolean): Promise<string> {
  const file = hostProjectHooksPath(root);
  const bytes = await readFile(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!interactive) {
    throw new HostCliExitError(`Review ${file}, then trust it with --sha256 ${sha256}`, 2);
  }
  process.stderr.write(`${file}\n${bytes.toString('utf8')}\nsha256 ${sha256}\n`);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question('Trust these project hooks? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new HostCliExitError('The project hooks were not trusted', 1);
    }
  } finally {
    terminal.close();
  }
  return sha256;
}
