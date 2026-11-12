// @vitest-environment node

/**
 * ADR-0034 decision 7, over real git and a real state store: an archived managed
 * worktree is listed for its repository, newest archive first, and restoring it
 * puts back its files and its uncommitted changes on its branch. A restore that
 * cannot happen says why and changes nothing.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import { StateStore } from '@brainstrike/state-store';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeLedger } from '../../src/git-workspace/worktree-ledger.ts';
import { createWorktreesMethods } from '../../src/git-workspace/worktrees-methods.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

describe('restoring an archived worktree (real git + real SQLite)', () => {
  let db: StateStore;
  let managedDirectory: string;
  let repo: string;
  const workspace = createTestWorkspace();

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-worktree-restore-state-'));
    repo = workspace.freshRepo('restore-repo');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  function service(otherRepo?: string) {
    return buildTestService(
      { db, managedDirectory, repo },
      otherRepo === undefined
        ? {}
        : {
            resolveRootCwd: async (rootId: string) => {
              if (rootId === 'r-1') {
                return { ok: true as const, value: repo };
              }
              if (rootId === 'r-2') {
                return { ok: true as const, value: otherRepo };
              }
              return {
                error: refusal({
                  category: 'input',
                  code: 'workspace.root-unknown',
                  message: 'unknown root',
                }),
                ok: false as const,
              };
            },
            resolveRootPaths: async () => [
              { id: 'r-1', path: repo },
              { id: 'r-2', path: otherRepo },
            ],
          }
    );
  }

  async function createWorktree(
    worktrees: ReturnType<typeof service>,
    name: string,
    rootId = 'r-1'
  ): Promise<ManagedWorktreeRow> {
    const created = await worktrees.create({
      baseRef: 'main',
      branch: { name: `bs/${name}` },
      createdBy: 'user',
      name,
      rootId,
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    return created.value.worktree;
  }

  async function archive(
    worktrees: ReturnType<typeof service>,
    worktree: ManagedWorktreeRow
  ): Promise<ManagedWorktreeRow> {
    // `force` is how the idle-worktree cap archives a worktree with uncommitted work.
    const archived = await worktrees.archive({ force: true, worktreeId: worktree.id });
    if (!archived.ok) {
      throw new Error(archived.error.message);
    }
    return archived.value.worktree;
  }

  /** The host's `worktrees/list-archived`, over the real service and ledger. */
  function listArchived(worktrees: ReturnType<typeof service>, rootId: string) {
    const ledger = createWorktreeLedger(
      async () => db,
      async () => false
    );
    const unused = () => Promise.reject(new Error('Worktree settings are not read here.'));
    return createWorktreesMethods({
      listRepositoryWorktrees: (repoCommonDir) => ledger.listForRepository(repoCommonDir),
      readSettings: unused,
      resolveService: () => worktrees,
      writeSettings: unused,
    }).listArchived({ rootId });
  }

  async function archivedIds(worktrees: ReturnType<typeof service>, rootId = 'r-1') {
    const listed = await listArchived(worktrees, rootId);
    if (!listed.ok) {
      throw new Error(listed.error.message);
    }
    return listed.value.map(({ id }) => id);
  }

  it('puts back the files, the uncommitted changes and the branch of an archived worktree', async () => {
    const worktrees = service();
    const worktree = await createWorktree(worktrees, 'restore-me');
    writeFileSync(path.join(worktree.path, 'committed.ts'), 'export const committed = true;\n');
    git(worktree.path, ['add', 'committed.ts']);
    git(worktree.path, ['commit', '-m', 'a commit only this branch has']);
    writeFileSync(path.join(worktree.path, 'hello.ts'), 'export const value = 2;\n');
    writeFileSync(path.join(worktree.path, 'notes.md'), 'not yet added\n');
    unlinkSync(path.join(worktree.path, 'committed.ts'));

    const archived = await archive(worktrees, worktree);
    expect(existsSync(worktree.path)).toBe(false);
    expect(await listArchived(worktrees, 'r-1')).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          archivedAt: expect.any(String),
          archiveSnapshotRef: `refs/brainstrike/worktree-archive/${worktree.id}`,
          branch: 'bs/restore-me',
          id: worktree.id,
          path: worktree.path,
        }),
      ],
    });
    expect(archived.archivedAt).not.toBeNull();

    const restored = await worktrees.restore({ worktreeId: worktree.id });

    expect(restored).toEqual({
      ok: true,
      value: expect.objectContaining({
        worktree: expect.objectContaining({
          archivedAt: null,
          archiveSnapshotRef: null,
          id: worktree.id,
          path: worktree.path,
        }),
      }),
    });
    expect(readFileSync(path.join(worktree.path, 'hello.ts'), 'utf8')).toBe(
      'export const value = 2;\n'
    );
    expect(readFileSync(path.join(worktree.path, 'notes.md'), 'utf8')).toBe('not yet added\n');
    expect(existsSync(path.join(worktree.path, 'committed.ts'))).toBe(false);
    expect(git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('bs/restore-me');
    expect(
      git(worktree.path, ['status', '--porcelain']).split('\n').filter(Boolean).sort()
    ).toEqual([' D committed.ts', ' M hello.ts', '?? notes.md']);
    expect(await archivedIds(worktrees)).toEqual([]);
  });

  it("lists only its repository's archived worktrees, newest archive first", async () => {
    const otherRepo = workspace.freshRepo('restore-other-repo');
    const worktrees = service(otherRepo);
    const first = await createWorktree(worktrees, 'archived-first');
    const second = await createWorktree(worktrees, 'archived-second');
    await createWorktree(worktrees, 'still-live');
    const elsewhere = await createWorktree(worktrees, 'other-repository', 'r-2');
    await archive(worktrees, first);
    await archive(worktrees, second);
    await archive(worktrees, elsewhere);

    expect(await archivedIds(worktrees)).toEqual([second.id, first.id]);
    expect(await archivedIds(worktrees, 'r-2')).toEqual([elsewhere.id]);
  });

  it('refuses a restore whose folder is taken, saying so, and keeps the worktree archived', async () => {
    const worktrees = service();
    const worktree = await archive(worktrees, await createWorktree(worktrees, 'occupied'));
    mkdirSync(worktree.path, { recursive: true });
    writeFileSync(path.join(worktree.path, 'someone-else.txt'), 'here first\n');

    expect(await worktrees.restore({ worktreeId: worktree.id })).toEqual({
      error: expect.objectContaining({
        code: 'worktree.restore-target-occupied',
        message: `"${worktree.path}" already exists and is not empty — move it aside before restoring.`,
      }),
      ok: false,
    });
    expect(await archivedIds(worktrees)).toEqual([worktree.id]);
  });

  it('refuses a restore whose snapshot is gone, saying so', async () => {
    const worktrees = service();
    const worktree = await archive(worktrees, await createWorktree(worktrees, 'snapshot-gone'));
    git(repo, ['update-ref', '-d', `refs/brainstrike/worktree-archive/${worktree.id}`]);

    expect(await worktrees.restore({ worktreeId: worktree.id })).toEqual({
      error: expect.objectContaining({
        code: 'worktree.snapshot-missing',
        message: `The archive snapshot "refs/brainstrike/worktree-archive/${worktree.id}" no longer exists in this repository, so this worktree cannot be restored.`,
      }),
      ok: false,
    });
    expect(existsSync(worktree.path)).toBe(false);
    expect(await archivedIds(worktrees)).toEqual([worktree.id]);
  });

  it('refuses a restore whose branch is checked out in another worktree, naming it', async () => {
    const worktrees = service();
    const worktree = await archive(worktrees, await createWorktree(worktrees, 'branch-taken'));
    const elsewhere = path.join(workspace.freshTempDir('bst-worktree-restore-elsewhere-'), 'copy');
    git(repo, ['worktree', 'add', elsewhere, 'bs/branch-taken']);

    const restored = await worktrees.restore({ worktreeId: worktree.id });

    expect(restored.ok).toBe(false);
    if (restored.ok) {
      throw new Error('Expected the restore to be refused.');
    }
    expect(restored.error.message).toContain("'bs/branch-taken'");
    expect(restored.error.message).toContain(path.basename(elsewhere));
    expect(existsSync(worktree.path)).toBe(false);
    expect(await archivedIds(worktrees)).toEqual([worktree.id]);
  });
});
