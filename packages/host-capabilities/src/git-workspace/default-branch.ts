/**
 * A repository's default branch, as its local view of `origin` records it.
 * The host never fetches, so this is the branch as of the person's last fetch.
 * Read by `branch-vs-base` changesets (BST-1113) and by archive on merge
 * (ADR-0034 build decisions, BST-2504).
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { gitRefused } from './git-failure.ts';
import { type GitCommandRun, stripLineEnding } from './git-service.ts';

type InvokeFn = (args: readonly string[], timeoutMs?: number) => Promise<GitCommandRun>;

/**
 * Base-ref resolution for `branch-vs-base` (settled, hard): explicit
 * `baseRef` wins; else `git symbolic-ref refs/remotes/origin/HEAD`; else a
 * fallback probe for `refs/remotes/origin/main`; else a visible typed error.
 * NEVER `@{u}` — that upstream-tracking form is deliberately never used
 * anywhere in this module.
 */
export async function resolveDefaultBaseRef(invoke: InvokeFn): Promise<BoundaryResult<string>> {
  const symbolicRun = await invoke(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolicRun.exitCode === 0) {
    const ref = stripLineEnding(symbolicRun.stdout)
      .trim()
      .replace(/^refs\/remotes\//u, '');
    if (ref.length > 0) {
      return { ok: true, value: ref };
    }
  }
  const probeRun = await invoke(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  if (probeRun.exitCode === 0) {
    return { ok: true, value: 'origin/main' };
  }
  return gitRefused(
    'input',
    'changeset.base-ref-unresolved',
    'could not resolve "origin/HEAD" or "origin/main"; specify an explicit baseRef.'
  );
}
