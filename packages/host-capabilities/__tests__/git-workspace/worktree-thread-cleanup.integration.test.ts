// @vitest-environment node

/**
 * BST-2505, over real git and a real state store: when a thread is deleted, the
 * managed worktrees the ledger records it made, and that no thread is bound to,
 * are archived through the idle-worktree cap's archive. The snapshot ref and the
 * branch are kept, so Restore brings each one back. The thread is gone, so no
 * one is told.
 */
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostIdleWorktreeArchive } from '@brainstrike/agent-host';
import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { StateStore } from '@brainstrike/state-store';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { createIdleWorktreeCap } from '../../src/git-workspace/worktree-idle-cap.ts';
import { createWorktreeLedger } from '../../src/git-workspace/worktree-ledger.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

interface ListedThread {
  readonly binding: ThreadWorkspaceBinding | null;
  readonly hasRun: boolean;
  readonly threadId: string;
}

/** The thread the tests delete. Core no longer lists it once its deletion has committed. */
const DELETED = 'deleted-thread';

describe("a deleted thread's worktrees (real git + real SQLite)", () => {
  let db: StateStore;
  let repo: string;
  let managedDirectory: string;
  let threads: ListedThread[];
  let running: Set<string>;
  let told: HostIdleWorktreeArchive[];
  const workspace = createTestWorkspace();

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-thread-cleanup-state-'));
    repo = workspace.freshRepo('thread-cleanup-repo');
    managedDirectory = workspace.freshManagedDir();
    threads = [];
    running = new Set();
    told = [];
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  /** The cap over the worktree service of `repository`, with no cap after its creates. */
  function host(repository = repo) {
    const ledger = createWorktreeLedger(
      async () => db,
      async (id) => running.has(id)
    );
    const service = buildTestService(
      { db, managedDirectory, repo: repository },
      { hasRunningThread: async (id) => running.has(id) }
    );
    const cap = createIdleWorktreeCap({
      archive: (params) => service.archive(params),
      listActive: () => ledger.listActive(),
      listRepository: (repoCommonDir) => ledger.listForRepository(repoCommonDir),
      listThread: (threadId) => ledger.listForThread(threadId),
      publish: (archive) => {
        told.push(archive);
      },
      readBaseCommit: (worktreeId) => ledger.baseCommit(worktreeId),
      readRoots: async () => [],
      readThreads: async () => threads,
      run: execFileGitRunner,
    });
    return { cap, service };
  }

  /** A worktree a thread's run made with `manageWorktree` create, and never entered. */
  async function made(
    service: ReturnType<typeof host>['service'],
    name: string,
    threadId = DELETED
  ): Promise<ManagedWorktreeRow> {
    const created = await service.create({
      baseRef: 'main',
      branch: { name: `bs/${name}` },
      createdBy: 'agent',
      name,
      rootId: 'r-1',
      runId: `run-of-${threadId}`,
      threadId,
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

  function expectArchived(row: ManagedWorktreeRow, archived: ManagedWorktreeRow): void {
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archiveSnapshotRef).toBe(`refs/brainstrike/worktree-archive/${row.id}`);
    expect(existsSync(row.path)).toBe(false);
    // The snapshot is a commit in the worktree's repository, and the branch is kept.
    const repository = path.dirname(row.repoCommonDir);
    expect(
      git(repository, ['cat-file', '-t', `refs/brainstrike/worktree-archive/${row.id}`]).trim()
    ).toBe('commit');
    expect(git(repository, ['branch', '--list', row.branch ?? '']).trim()).not.toBe('');
  }

  async function expectKept(row: ManagedWorktreeRow): Promise<void> {
    expect((await ledgerRow(row.id)).archivedAt).toBeNull();
    expect(existsSync(row.path)).toBe(true);
  }

  it('archives the worktree a deleted thread made that no thread is bound to, keeping its work, snapshot ref and branch', async () => {
    const { cap, service } = host();
    const left = await made(service, 'never-entered');
    writeFileSync(path.join(left.path, 'draft.ts'), 'export const draft = true;\n');

    await cap.afterThreadDeleted(DELETED);

    expectArchived(left, await ledgerRow(left.id));
    const ref = `refs/brainstrike/worktree-archive/${left.id}`;
    expect(git(repo, ['show', `${ref}:draft.ts`])).toBe('export const draft = true;\n');
    // The thread is gone: there is no one to tell.
    expect(told).toEqual([]);
  });

  it('archives the worktrees it made in every repository', async () => {
    const other = workspace.freshRepo('thread-cleanup-other');
    const mine = await made(host().service, 'here');
    const there = await made(host(other).service, 'there');

    await host().cap.afterThreadDeleted(DELETED);

    expect(realpathSync(path.dirname(there.repoCommonDir))).toBe(realpathSync(other));
    expectArchived(mine, await ledgerRow(mine.id));
    expectArchived(there, await ledgerRow(there.id));
  });

  it('keeps a worktree it made that another thread is now bound to', async () => {
    const { cap, service } = host();
    const taken = await made(service, 'taken');
    const left = await made(service, 'left');
    threads = [
      {
        binding: {
          checkoutLocalRootId: 'r-1',
          checkoutMode: 'worktree',
          checkoutWorktreeId: taken.id,
          checkoutWorktreePath: taken.path,
          operatingRootDisplayName: 'taken',
          operatingRootId: 'taken-root',
          operatingRootPath: taken.path,
        },
        hasRun: true,
        threadId: 'thread-2',
      },
    ];

    await cap.afterThreadDeleted(DELETED);

    await expectKept(taken);
    expectArchived(left, await ledgerRow(left.id));
  });

  it('keeps a worktree it made where a run is active', async () => {
    const { cap, service } = host();
    const busy = await made(service, 'busy');
    const left = await made(service, 'left');
    running.add(busy.id);

    await cap.afterThreadDeleted(DELETED);

    await expectKept(busy);
    expectArchived(left, await ledgerRow(left.id));
  });

  it('keeps a worktree another thread made', async () => {
    const { cap, service } = host();
    const mine = await made(service, 'mine');
    const theirs = await made(service, 'theirs', 'thread-2');
    threads = [{ binding: null, hasRun: true, threadId: 'thread-2' }];

    await cap.afterThreadDeleted(DELETED);

    expectArchived(mine, await ledgerRow(mine.id));
    await expectKept(theirs);
  });
});
