/**
 * Snapshot + safety gate for `git worktree remove` (spec §6.3).
 *
 * WHY NOT the shadow-git SnapshotService: it is keyed per ROOT *and* per THREAD
 * (`snapshotRefForThread`) with a closed `SnapshotKind` union that THROWS on an
 * unknown kind — and a managed worktree deliberately outlives its thread. So
 * the archive snapshot is a real commit in the worktree's OWN repository, built
 * with the same temp-index → write-tree → commit-tree → update-ref technique
 * `snapshot-git.ts` uses. It lives in the common dir, so it survives the
 * removal; `git restore --source=<ref>` replays it; and `git ls-tree` makes it
 * inspectable with ordinary git.
 *
 * `git add -A` inside the worktree honors `.gitignore`, so `node_modules` and
 * other ignored trees are NOT captured — the snapshot is the user's work, not
 * their dependency cache.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitResult, ManagedWorktreeRow } from '@brainstrike/types';
import {
  describeFailure,
  GIT_DEFAULT_TIMEOUT_MS,
  type GitCommandRun,
  type GitCommandRunner,
  invokeGitHookFree,
} from './git-service';

export type GitInvoke = (args: readonly string[], timeoutMs?: number) => Promise<GitCommandRun>;

export function archiveSnapshotRef(worktreeId: string): string {
  return `refs/brainstrike/worktree-archive/${worktreeId}`;
}

export interface WorktreeSafetyReport {
  readonly blockers: readonly string[];
  readonly dirty: boolean;
  readonly unpushedCommits: number;
}

export async function inspectWorktreeSafety(input: {
  readonly baseRef: string;
  readonly invoke: GitInvoke;
  readonly lockedReason: string | null;
  readonly threadIsRunning: boolean;
}): Promise<GitResult<WorktreeSafetyReport>> {
  const blockers: string[] = [];
  if (input.threadIsRunning) {
    blockers.push('A run is active in this worktree. Wait for it to finish, or stop it first.');
  }
  if (input.lockedReason !== null) {
    blockers.push(`This worktree is locked: ${input.lockedReason}`);
  }
  const statusRun = await invokeGitHookFree(input.invoke, [
    'status',
    '--porcelain=v2',
    '--untracked-files=all',
  ]);
  if (statusRun.exitCode !== 0) {
    return { error: describeFailure(statusRun), ok: false };
  }
  const dirty = statusRun.stdout.trim().length > 0;
  if (dirty) {
    blockers.push(
      'This worktree has uncommitted changes. Archive anyway to keep a restorable snapshot, or commit them first.'
    );
  }
  const unpushedRun = await invokeGitHookFree(input.invoke, [
    'rev-list',
    '--count',
    `${input.baseRef}..HEAD`,
    '--not',
    '--remotes',
  ]);
  if (unpushedRun.exitCode !== 0) {
    return { error: describeFailure(unpushedRun), ok: false };
  }
  const unpushedCommits = Number.parseInt(unpushedRun.stdout.trim(), 10);
  if (!Number.isFinite(unpushedCommits)) {
    return { error: `git rev-list returned "${unpushedRun.stdout.trim()}"`, ok: false };
  }
  if (unpushedCommits > 0) {
    blockers.push(
      `This worktree has ${unpushedCommits} commit${unpushedCommits === 1 ? '' : 's'} that ${
        unpushedCommits === 1 ? 'is' : 'are'
      } not on any remote. Archive anyway to keep a restorable snapshot, or push ${
        unpushedCommits === 1 ? 'it' : 'them'
      } first.`
    );
  }
  return { ok: true, value: { blockers, dirty, unpushedCommits } };
}

export async function captureArchiveSnapshot(input: {
  readonly cwd: string;
  readonly run: GitCommandRunner;
  readonly worktree: ManagedWorktreeRow;
}): Promise<GitResult<string>> {
  const indexPath = path.join(tmpdir(), `bst-worktree-archive-${randomUUID()}.index`);
  const env: Record<string, string> = {};
  env['GIT_INDEX_FILE'] = indexPath;
  const invokeWithIndex: GitInvoke = (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) =>
    input.run({ args, cwd: input.cwd, env, timeoutMs });
  const invokeNoIndex: GitInvoke = (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) =>
    input.run({ args, cwd: input.cwd, timeoutMs });
  try {
    // `read-tree HEAD` seeds the temp index so `add -A` records DELETIONS too;
    // an empty index would make every deleted file look untouched.
    const seed = await invokeGitHookFree(invokeWithIndex, ['read-tree', 'HEAD']);
    if (seed.exitCode !== 0 && !seed.stderr.includes('unknown revision')) {
      return { error: describeFailure(seed), ok: false };
    }
    const add = await invokeGitHookFree(invokeWithIndex, ['add', '-A']);
    if (add.exitCode !== 0) {
      return { error: describeFailure(add), ok: false };
    }
    const writeTree = await invokeGitHookFree(invokeWithIndex, ['write-tree']);
    if (writeTree.exitCode !== 0) {
      return { error: describeFailure(writeTree), ok: false };
    }
    const treeOid = writeTree.stdout.trim();
    const headRun = await invokeGitHookFree(invokeNoIndex, ['rev-parse', '--verify', 'HEAD']);
    const parentArgs = headRun.exitCode === 0 ? ['-p', headRun.stdout.trim()] : [];
    const message = JSON.stringify({
      branch: input.worktree.branch,
      kind: 'worktree-archive',
      path: input.worktree.path,
      worktreeId: input.worktree.id,
    });
    const commit = await invokeGitHookFree(invokeNoIndex, [
      'commit-tree',
      treeOid,
      ...parentArgs,
      '-m',
      message,
    ]);
    if (commit.exitCode !== 0) {
      return { error: describeFailure(commit), ok: false };
    }
    const ref = archiveSnapshotRef(input.worktree.id);
    const update = await invokeGitHookFree(invokeNoIndex, [
      'update-ref',
      ref,
      commit.stdout.trim(),
    ]);
    if (update.exitCode !== 0) {
      return { error: describeFailure(update), ok: false };
    }
    return { ok: true, value: ref };
  } finally {
    await fsPromises.rm(indexPath, { force: true });
  }
}
