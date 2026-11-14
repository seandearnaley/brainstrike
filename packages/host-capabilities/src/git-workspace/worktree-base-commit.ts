/**
 * ADR-0034 build decisions (BST-2518): the commit a managed worktree was made
 * at, which the ledger records with it (`baseCommit`). Archive on merge takes a
 * worktree only once its branch has moved from that commit, so one made at a
 * commit the default branch already has, or later takes, and never committed
 * to, stays the idle cap's (`worktree-merged.ts`).
 */
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { gitCommandFailed } from './git-failure.ts';
import { invokeGitHookFree, stripLineEnding } from './git-service.ts';
import type { GitInvoke } from './worktree-archive.ts';

/**
 * The commit a worktree just made has checked out, read in its own folder after `git worktree
 * add`. Throws the git failure, as the ledger insert it feeds does, so the creation undoes the
 * worktree it made.
 */
export async function readCreatedAtCommit(worktree: GitInvoke): Promise<string> {
  const headRun = await invokeGitHookFree(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (headRun.exitCode !== 0) {
    throw new BoundaryFailureError(gitCommandFailed(headRun).error);
  }
  return stripLineEnding(headRun.stdout).trim();
}
