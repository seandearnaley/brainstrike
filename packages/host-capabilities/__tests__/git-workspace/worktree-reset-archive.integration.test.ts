// @vitest-environment node

/**
 * ADR-0015, ADR-0034, over real git and a real state store: before Factory Reset deletes the
 * state DB that holds the worktree ledger, every active managed worktree is archived into its
 * repository through the worktree service's own archive. The snapshot ref keeps its uncommitted
 * changes and the branch stays; the folder and git's registration go. A worktree the archive may
 * not touch stays on disk and is named with its path and why.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

describe("Factory Reset's archive of the managed worktrees (real git + real SQLite)", () => {
  let db: StateStore;
  let repo: string;
  let managedDirectory: string;
  let running: Set<string>;
  const workspace = createTestWorkspace();

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-reset-archive-state-'));
    repo = workspace.freshRepo('reset-archive-repo');
    managedDirectory = workspace.freshManagedDir();
    running = new Set();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  function service() {
    return buildTestService(
      { db, managedDirectory, repo },
      { hasRunningThread: async (id) => running.has(id) }
    );
  }

  async function create(name: string): Promise<ManagedWorktreeRow> {
    const created = await service().create({
      baseRef: 'main',
      branch: { name: `bs/${name}` },
      createdBy: 'agent',
      name,
      rootId: 'r-1',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    return created.value.worktree;
  }

  async function ledgerRow(id: string): Promise<ManagedWorktreeRow> {
    const row = (await db.worktreeLedger({ id, operation: 'get' })).rows[0];
    if (!row) {
      throw new Error(`No ledger row ${id}`);
    }
    return row;
  }

  function registeredWorktreePaths(): string[] {
    return git(repo, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
  }

  it('archives every active worktree into its repository, keeping its uncommitted work and its branch', async () => {
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore dependencies']);
    const clean = await create('clean');
    const withWork = await create('with-work');
    // A change to a tracked file, a new file and ignored files: the reset forces past all three.
    writeFileSync(path.join(withWork.path, 'hello.ts'), 'export const value = 2;\n');
    writeFileSync(path.join(withWork.path, 'draft.ts'), 'export const draft = true;\n');
    mkdirSync(path.join(withWork.path, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(withWork.path, 'node_modules', 'pkg', 'index.js'), 'x\n');

    const outcome = await service().archiveForReset();

    if (!outcome.ok) {
      throw new Error(outcome.error.message);
    }
    expect(outcome.value.retained).toEqual([]);
    expect(
      [...outcome.value.archived].sort((left, right) => left.path.localeCompare(right.path))
    ).toEqual(
      [clean, withWork]
        .map((row) => ({
          path: row.path,
          snapshotRef: `refs/brainstrike/worktree-archive/${row.id}`,
          worktreeId: row.id,
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
    );
    for (const row of [clean, withWork]) {
      const ref = `refs/brainstrike/worktree-archive/${row.id}`;
      expect(existsSync(row.path)).toBe(false);
      expect(registeredWorktreePaths()).not.toContain(row.path);
      expect(git(repo, ['cat-file', '-t', ref]).trim()).toBe('commit');
      expect(git(repo, ['branch', '--list', row.branch ?? '']).trim()).not.toBe('');
      const archived = await ledgerRow(row.id);
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.archiveSnapshotRef).toBe(ref);
    }
    const ref = `refs/brainstrike/worktree-archive/${withWork.id}`;
    expect(git(repo, ['show', `${ref}:hello.ts`])).toBe('export const value = 2;\n');
    expect(git(repo, ['show', `${ref}:draft.ts`])).toBe('export const draft = true;\n');
  });

  it('leaves a locked worktree, one with a nested repository and one where a run is active, and names each with its path and why', async () => {
    const locked = await create('locked');
    const nested = await create('nested');
    const active = await create('active');
    const idle = await create('idle');
    git(repo, ['worktree', 'lock', '--reason', 'on a removable drive', locked.path]);
    const inner = path.join(nested.path, 'vendor', 'tool');
    mkdirSync(inner, { recursive: true });
    git(inner, ['init', '-b', 'main']);
    running.add(active.id);

    const outcome = await service().archiveForReset();

    if (!outcome.ok) {
      throw new Error(outcome.error.message);
    }
    expect(
      [...outcome.value.retained].sort((left, right) => left.path.localeCompare(right.path))
    ).toEqual(
      [
        {
          code: 'worktree.run-active',
          path: active.path,
          reason: 'A run is active in this worktree.',
          worktreeId: active.id,
        },
        {
          code: 'worktree.locked',
          path: locked.path,
          reason: 'This worktree is locked.',
          worktreeId: locked.id,
        },
        {
          code: 'worktree.nested-repositories',
          path: nested.path,
          reason: 'This worktree holds nested repositories, which its archive cannot keep.',
          worktreeId: nested.id,
        },
      ].sort((left, right) => left.path.localeCompare(right.path))
    );
    for (const kept of [locked, nested, active]) {
      expect(existsSync(kept.path)).toBe(true);
      expect((await ledgerRow(kept.id)).archivedAt).toBeNull();
    }
    expect(outcome.value.archived.map(({ worktreeId }) => worktreeId)).toEqual([idle.id]);
    expect(existsSync(idle.path)).toBe(false);
  });

  // A run still in progress could otherwise make a worktree after the reset's list was read,
  // which the reset would then leave on disk unnamed.
  it('makes no further worktree once the reset has archived them', async () => {
    const archivedBefore = await create('before');
    const worktrees = service();

    const outcome = await worktrees.archiveForReset();
    const after = await worktrees.create({
      baseRef: 'main',
      branch: { name: 'bs/after' },
      createdBy: 'agent',
      name: 'after',
      rootId: 'r-1',
    });

    expect(outcome.ok && outcome.value.archived.map(({ worktreeId }) => worktreeId)).toEqual([
      archivedBefore.id,
    ]);
    expect(after).toMatchObject({ error: { code: 'worktree.resetting' }, ok: false });
    expect(registeredWorktreePaths()).toEqual([git(repo, ['rev-parse', '--show-toplevel']).trim()]);
    expect((await db.worktreeLedger({ operation: 'list-active' })).rows).toEqual([]);
  });
});
