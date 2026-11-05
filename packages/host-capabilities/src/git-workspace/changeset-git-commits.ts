/**
 * A worktree's latest commits, for the Changes commit picker (ADR-0036). Each
 * opens as the `commit` git scope. Git's own log of the worktree's HEAD,
 * newest first, with its output flags pinned so user config cannot change
 * the text; an unborn HEAD has none.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ChangesCommit } from '@brainstrike/types';
import {
  type GitScopeDeps,
  isHeadUnborn,
  resolveContainedWorktreeCwd,
} from './changeset-git-scope.ts';
import { gitCommandFailed, gitUnexpected } from './git-failure.ts';
import { GIT_DEFAULT_TIMEOUT_MS } from './git-service.ts';

/** The most commits the picker lists. */
export const WORKTREE_COMMIT_LIMIT = 50;

const COMMIT_ID = /^[0-9a-f]{40,64}$/u;

/** `git log -z --format=%H%x00%s`: id and subject, each commit ended by NUL. */
function parseCommits(stdout: string): BoundaryResult<readonly ChangesCommit[]> {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  const commits: ChangesCommit[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const commitId = fields[index];
    const subject = fields[index + 1];
    if (commitId === undefined || subject === undefined || !COMMIT_ID.test(commitId)) {
      return gitUnexpected('git log listed a commit without an id and subject');
    }
    commits.push({ commitId, subject });
  }
  return { ok: true, value: commits };
}

export async function listWorktreeCommits(
  deps: GitScopeDeps,
  rootId: unknown,
  worktreePath: string
): Promise<BoundaryResult<readonly ChangesCommit[]>> {
  const cwd = await resolveContainedWorktreeCwd(deps, rootId, worktreePath);
  if (!cwd.ok) {
    return cwd;
  }
  const git = (args: readonly string[]) =>
    deps.run({ args, cwd: cwd.value, timeoutMs: GIT_DEFAULT_TIMEOUT_MS });
  if (await isHeadUnborn(git)) {
    return { ok: true, value: [] };
  }
  const log = await git([
    'log',
    '-z',
    `--max-count=${WORKTREE_COMMIT_LIMIT}`,
    '--format=%H%x00%s',
    '--encoding=UTF-8',
    '--no-show-signature',
    '--no-color',
    'HEAD',
    '--',
  ]);
  if (log.exitCode !== 0) {
    return gitCommandFailed(log);
  }
  return parseCommits(log.stdout);
}
