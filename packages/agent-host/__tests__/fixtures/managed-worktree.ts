/**
 * Real git repositories and linked worktrees for trust tests: a managed
 * worktree is a folder the ledger lists and git's own two links join to its
 * repository, so the tests build both with git.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { StateStore } from '@brainstrike/state-store';
import type { ManagedWorktreeRow } from '@brainstrike/types';

export interface Repository {
  readonly commonDir: string;
  readonly path: string;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** A real repository with one commit; its common dir is its primary checkout's `.git`. */
export async function repositoryAt(path: string): Promise<Repository> {
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.email', 'test@brainstrike.invalid']);
  git(path, ['config', 'user.name', 'BrainStrike Test']);
  git(path, ['commit', '--allow-empty', '-m', 'initial commit']);
  return { commonDir: join(path, '.git'), path };
}

/** The ledger row Brainstrike keeps for a folder it manages as a worktree of `repoCommonDir`. */
export async function recordWorktree(
  store: StateStore,
  path: string,
  repoCommonDir: string
): Promise<ManagedWorktreeRow> {
  const row: ManagedWorktreeRow = {
    archivedAt: null,
    archiveSnapshotRef: null,
    baseRef: 'main',
    branch: null,
    createdAt: new Date().toISOString(),
    createdBy: 'user',
    id: randomUUID(),
    path,
    repoCommonDir,
    runId: null,
    setupOutput: null,
    setupReason: null,
    setupStatus: 'none',
    threadId: null,
  };
  await store.worktreeLedger({ operation: 'insert', row: { ...row, baseCommit: 'a'.repeat(40) } });
  return row;
}

/**
 * A real linked worktree of `repository` inside `managedDir` (an empty folder,
 * by its real path), as `git worktree add` leaves it: the ledger does not list it.
 */
export function linkWorktree(repository: Repository, managedDir: string): string {
  const path = join(managedDir, 'swift-badger');
  git(repository.path, ['worktree', 'add', '--detach', path]);
  // Git makes the folder under the machine's umask, which on Debian, Ubuntu and Fedora leaves
  // it writable by its group. These tests are about a folder only the person can add to.
  chmodSync(path, 0o755);
  return path;
}

/**
 * A real linked worktree of `repository` inside `managedDir` (an empty folder,
 * by its real path, as the ledger keeps it) and its ledger row, as worktree
 * creation leaves them.
 */
export function addManagedWorktree(
  store: StateStore,
  repository: Repository,
  managedDir: string
): Promise<ManagedWorktreeRow> {
  return recordWorktree(store, linkWorktree(repository, managedDir), repository.commonDir);
}
