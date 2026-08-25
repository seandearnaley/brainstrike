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
  readonly ignoredFileCount: number;
  readonly threadIsRunning: boolean;
  readonly unpushedCommits: number;
}

interface UnpushedSafety {
  readonly blocker: string | null;
  readonly count: number;
}

async function inspectUnpushedSafety(input: {
  readonly baseRef: string;
  readonly invoke: GitInvoke;
}): Promise<GitResult<UnpushedSafety>> {
  const baseRefRun = await invokeGitHookFree(input.invoke, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${input.baseRef}^{commit}`,
  ]);
  if (baseRefRun.exitCode === 1) {
    return {
      ok: true,
      value: {
        blocker: `this worktree's base ref \`${input.baseRef}\` no longer exists, so unpushed commits cannot be assessed`,
        count: 0,
      },
    };
  }
  if (baseRefRun.exitCode !== 0) {
    return { error: describeFailure(baseRefRun), ok: false };
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
  const count = Number.parseInt(unpushedRun.stdout.trim(), 10);
  if (!Number.isFinite(count)) {
    return { error: `git rev-list returned "${unpushedRun.stdout.trim()}"`, ok: false };
  }
  if (count === 0) {
    return { ok: true, value: { blocker: null, count } };
  }
  return {
    ok: true,
    value: {
      blocker: `This worktree has ${count} commit${count === 1 ? '' : 's'} that ${
        count === 1 ? 'is' : 'are'
      } not on any remote. Archive anyway to keep a restorable snapshot, or push ${
        count === 1 ? 'it' : 'them'
      } first.`,
      count,
    },
  };
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
    '--porcelain',
    '--untracked-files=all',
    '--ignored=matching',
  ]);
  if (statusRun.exitCode !== 0) {
    return { error: describeFailure(statusRun), ok: false };
  }
  const statusEntries = statusRun.stdout.split('\n').filter((entry) => entry.length > 0);
  const ignoredFileCount = statusEntries.filter((entry) => entry.startsWith('!! ')).length;
  const dirty = statusEntries.some((entry) => !entry.startsWith('!! '));
  if (dirty) {
    blockers.push(
      'This worktree has uncommitted changes. Archive anyway to keep a restorable snapshot, or commit them first.'
    );
  }
  const unpushed = await inspectUnpushedSafety(input);
  if (!unpushed.ok) {
    return unpushed;
  }
  if (unpushed.value.blocker !== null) {
    blockers.push(unpushed.value.blocker);
  }
  return {
    ok: true,
    value: {
      blockers,
      dirty,
      ignoredFileCount,
      threadIsRunning: input.threadIsRunning,
      unpushedCommits: unpushed.value.count,
    },
  };
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
    const headRun = await invokeGitHookFree(invokeNoIndex, [
      'rev-parse',
      '--verify',
      '--quiet',
      'HEAD',
    ]);
    if (headRun.exitCode !== 0 && headRun.exitCode !== 1) {
      return { error: describeFailure(headRun), ok: false };
    }
    // `read-tree HEAD` seeds the temp index so `add -A` records DELETIONS too;
    // an empty index would make every deleted file look untouched. Exit 1 from
    // the quiet verification is Git's explicit unborn-HEAD result; only that
    // case starts from an empty index.
    if (headRun.exitCode === 0) {
      const seed = await invokeGitHookFree(invokeWithIndex, ['read-tree', 'HEAD']);
      if (seed.exitCode !== 0) {
        return { error: describeFailure(seed), ok: false };
      }
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
