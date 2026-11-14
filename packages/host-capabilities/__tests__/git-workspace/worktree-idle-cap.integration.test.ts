// @vitest-environment node

/**
 * ADR-0034 decision 7, over real git and a real state store: after a worktree
 * is created for a thread, a repository keeps at most 15 idle managed
 * worktrees. The oldest beyond 15 are archived through the service's own
 * archive, which keeps their snapshot, and the thread is told.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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

describe('the idle-worktree cap (real git + real SQLite)', () => {
  let db: StateStore;
  let repo: string;
  let managedDirectory: string;
  let threads: ListedThread[];
  let roots: { canonicalPath: string; id: string; path: string }[];
  let running: Set<string>;
  let told: HostIdleWorktreeArchive[];
  /** Replaces the thread list the cap reads, after the reads it has made so far. */
  let readThreads: () => Promise<readonly ListedThread[]>;
  const workspace = createTestWorkspace();

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-idle-cap-state-'));
    repo = workspace.freshRepo('idle-cap-repo');
    managedDirectory = workspace.freshManagedDir();
    threads = [{ binding: null, hasRun: true, threadId: 'thread-1' }];
    roots = [];
    running = new Set();
    told = [];
    readThreads = async () => threads;
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  /** The service with the cap after its creates; `started` holds each cap a create started. */
  function host() {
    const started: Promise<void>[] = [];
    const ledger = createWorktreeLedger(
      async () => db,
      async (id) => running.has(id)
    );
    const cap = createIdleWorktreeCap({
      archive: (params) => service.archive(params),
      listActive: () => ledger.listActive(),
      listRepository: (repoCommonDir) => ledger.listForRepository(repoCommonDir),
      publish: (archive) => {
        told.push(archive);
      },
      readRoots: async () => roots,
      readThreads: () => readThreads(),
      run: execFileGitRunner,
    });
    const service = buildTestService(
      { db, managedDirectory, repo },
      {
        afterCreate: (worktree, params) => {
          started.push(cap.afterCreate(worktree, params));
        },
        hasRunningThread: async (id) => running.has(id),
      }
    );
    return { service, started };
  }

  /**
   * An idle managed worktree on `bs/<name>`, recorded `order` minutes into 2026. A worktree
   * the cap only counts is a recorded folder, not a git checkout, which keeps the suite fast.
   */
  async function seed(
    name: string,
    order: number,
    repository: string,
    checkout: boolean
  ): Promise<ManagedWorktreeRow> {
    const commonDir = realpathSync(path.join(repository, '.git'));
    const target = path.join(realpathSync(managedDirectory), path.basename(repository), name);
    if (checkout) {
      git(repository, ['worktree', 'add', '--quiet', '-b', `bs/${name}`, '--', target, 'main']);
    } else {
      mkdirSync(target, { recursive: true });
    }
    const { rows } = await db.worktreeLedger({
      operation: 'insert',
      row: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: 'main',
        branch: `bs/${name}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, order)).toISOString(),
        createdBy: 'user',
        id: randomUUID(),
        path: target,
        repoCommonDir: commonDir,
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: null,
      },
    });
    const row = rows[0];
    if (!row) {
      throw new Error('The ledger recorded no row');
    }
    return row;
  }

  /**
   * `count` idle worktrees, oldest first. Every one the cap could archive is a real checkout,
   * and so is the oldest of 15: a cap that archived it wrongly would remove a real worktree.
   */
  async function seedMany(count: number, repository = repo): Promise<ManagedWorktreeRow[]> {
    const checkouts = Math.max(count - 15, 1);
    const seeded: ManagedWorktreeRow[] = [];
    for (let order = 0; order < count; order += 1) {
      const name = `idle-${String(order).padStart(2, '0')}`;
      seeded.push(await seed(name, order, repository, order < checkouts));
    }
    return seeded;
  }

  /** A worktree made for `thread-1` in run `run-1`, then the cap that creation started. */
  async function createForThread(
    provenance: { readonly runId?: string; readonly threadId?: string } = {
      runId: 'run-1',
      threadId: 'thread-1',
    },
    name = 'fresh'
  ): Promise<ManagedWorktreeRow> {
    const { service, started } = host();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: `bs/${name}` },
      createdBy: 'agent',
      name,
      rootId: 'r-1',
      ...provenance,
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    expect(started).toHaveLength(1);
    await Promise.all(started);
    return created.value.worktree;
  }

  async function ledgerRow(id: string): Promise<ManagedWorktreeRow> {
    const row = (await db.worktreeLedger({ id, operation: 'get' })).rows[0];
    if (!row) {
      throw new Error(`No ledger row ${id}`);
    }
    return row;
  }

  async function activeIds(): Promise<string[]> {
    return (await db.worktreeLedger({ operation: 'list-active' })).rows.map((row) => row.id);
  }

  function expectArchived(row: ManagedWorktreeRow, archived: ManagedWorktreeRow): void {
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archiveSnapshotRef).toBe(`refs/brainstrike/worktree-archive/${row.id}`);
    expect(existsSync(row.path)).toBe(false);
    // The snapshot is a commit in the repository, and the branch is kept.
    expect(
      git(repo, ['cat-file', '-t', `refs/brainstrike/worktree-archive/${row.id}`]).trim()
    ).toBe('commit');
    expect(git(repo, ['branch', '--list', row.branch ?? '']).trim()).not.toBe('');
  }

  it('archives the oldest of 16 idle worktrees after a creation for a thread, and tells that thread', async () => {
    const [oldest, ...rest] = await seedMany(16);
    if (!oldest) {
      throw new Error('Seeded nothing');
    }

    const fresh = await createForThread();

    expectArchived(oldest, await ledgerRow(oldest.id));
    // Fifteen idle worktrees remain, beside the one just made for the thread.
    expect((await activeIds()).sort()).toEqual([fresh.id, ...rest.map((row) => row.id)].sort());
    for (const row of rest) {
      expect(existsSync(row.path)).toBe(true);
    }
    expect(told).toEqual([
      {
        limit: 15,
        reason: 'idle-cap',
        runId: 'run-1',
        threadId: 'thread-1',
        worktrees: [
          {
            branch: 'bs/idle-00',
            name: 'idle-00',
            snapshotRef: `refs/brainstrike/worktree-archive/${oldest.id}`,
            worktreeId: oldest.id,
          },
        ],
      },
    ]);
  });

  it('archives nothing while a repository has 15 idle worktrees', async () => {
    const seeded = await seedMany(15);

    const fresh = await createForThread();

    expect((await activeIds()).sort()).toEqual([fresh.id, ...seeded.map((row) => row.id)].sort());
    expect(told).toEqual([]);
  });

  it('never archives a worktree a thread is bound to, however old', async () => {
    const [asCheckout, asFolder, asOtherFolder, oldestIdle, ...rest] = await seedMany(19);
    if (!(asCheckout && asFolder && asOtherFolder && oldestIdle)) {
      throw new Error('Seeded too few');
    }
    roots = [
      { canonicalPath: asFolder.path, id: 'folder-root', path: asFolder.path },
      { canonicalPath: asOtherFolder.path, id: 'other-root', path: asOtherFolder.path },
    ];
    threads = [
      { binding: null, hasRun: true, threadId: 'thread-1' },
      {
        binding: {
          checkoutLocalRootId: 'r-1',
          checkoutMode: 'worktree',
          checkoutWorktreeId: asCheckout.id,
          checkoutWorktreePath: asCheckout.path,
          operatingRootDisplayName: 'idle-00',
          operatingRootId: 'checkout-root',
          operatingRootPath: asCheckout.path,
        },
        hasRun: true,
        threadId: 'thread-2',
      },
      {
        binding: { operatingRootDisplayName: 'idle-01', operatingRootId: 'folder-root' },
        hasRun: true,
        threadId: 'thread-3',
      },
      {
        binding: {
          operatingRootDisplayName: 'app',
          operatingRootId: 'r-1',
          secondaryRootIds: ['other-root'],
        },
        hasRun: true,
        threadId: 'thread-4',
      },
    ];

    await createForThread();

    for (const bound of [asCheckout, asFolder, asOtherFolder]) {
      expect((await ledgerRow(bound.id)).archivedAt).toBeNull();
      expect(existsSync(bound.path)).toBe(true);
    }
    // Sixteen idle worktrees: the oldest of them goes.
    expectArchived(oldestIdle, await ledgerRow(oldestIdle.id));
    for (const row of rest) {
      expect((await ledgerRow(row.id)).archivedAt).toBeNull();
    }
    expect(told.flatMap(({ worktrees }) => worktrees.map(({ name }) => name))).toEqual(['idle-03']);
  });

  // A folder inside a managed worktree, opened as a folder of its own, is that worktree's files:
  // archiving the worktree would take the folder from the thread working in it.
  it('never archives a worktree that holds a folder a thread is bound to', async () => {
    const [holder] = await seedMany(16);
    if (!holder) {
      throw new Error('Seeded nothing');
    }
    const inside = path.join(holder.path, 'packages', 'app');
    mkdirSync(inside, { recursive: true });
    roots = [{ canonicalPath: inside, id: 'inside-root', path: inside }];
    threads = [
      { binding: null, hasRun: true, threadId: 'thread-1' },
      {
        binding: { operatingRootDisplayName: 'app', operatingRootId: 'inside-root' },
        hasRun: true,
        threadId: 'thread-2',
      },
    ];

    await createForThread();

    expect((await ledgerRow(holder.id)).archivedAt).toBeNull();
    expect(existsSync(inside)).toBe(true);
    // The other fifteen are within the cap.
    expect(told).toEqual([]);
  });

  it('leaves a worktree a thread took while the cap waited to archive it', async () => {
    const [oldest] = await seedMany(16);
    if (!oldest) {
      throw new Error('Seeded nothing');
    }
    // The first read chooses what to archive; by the archive's own turn the thread has taken it.
    let reads = 0;
    readThreads = async () => {
      reads += 1;
      return reads === 1
        ? threads
        : [
            ...threads,
            {
              binding: {
                checkoutLocalRootId: 'r-1',
                checkoutMode: 'worktree',
                checkoutWorktreeId: oldest.id,
                checkoutWorktreePath: oldest.path,
              },
              hasRun: true,
              threadId: 'thread-2',
            },
          ];
    };

    await createForThread();

    expect((await ledgerRow(oldest.id)).archivedAt).toBeNull();
    expect(existsSync(oldest.path)).toBe(true);
    expect(told).toEqual([]);
  });

  it('skips a locked worktree, one with a nested repository and one where a run is active', async () => {
    const [locked, nested, active, ...rest] = await seedMany(18);
    if (!(locked && nested && active)) {
      throw new Error('Seeded too few');
    }
    git(repo, ['worktree', 'lock', '--reason', 'on a removable drive', locked.path]);
    const inner = path.join(nested.path, 'vendor', 'tool');
    mkdirSync(inner, { recursive: true });
    git(inner, ['init', '-b', 'main']);
    running.add(active.id);

    await createForThread();

    // Each keeps its place: no younger worktree is archived in its stead.
    for (const kept of [locked, nested, active, ...rest]) {
      expect((await ledgerRow(kept.id)).archivedAt).toBeNull();
      expect(existsSync(kept.path)).toBe(true);
    }
    expect(told).toEqual([]);
  });

  it('archives an idle worktree with uncommitted work and ignored files, keeping its work restorable', async () => {
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore dependencies and secrets']);
    const [oldest] = await seedMany(16);
    if (!oldest) {
      throw new Error('Seeded nothing');
    }
    // An unpushed commit on its branch, then uncommitted changes and ignored files.
    writeFileSync(path.join(oldest.path, 'committed.ts'), 'export const committed = true;\n');
    git(oldest.path, ['add', 'committed.ts']);
    git(oldest.path, [
      '-c',
      'user.email=test@brainstrike.invalid',
      '-c',
      'user.name=BrainStrike Test',
      'commit',
      '-m',
      'work on its branch',
    ]);
    writeFileSync(path.join(oldest.path, 'hello.ts'), 'export const value = 2;\n');
    writeFileSync(path.join(oldest.path, 'draft.ts'), 'export const draft = true;\n');
    mkdirSync(path.join(oldest.path, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(oldest.path, 'node_modules', 'pkg', 'index.js'), 'x\n');
    writeFileSync(path.join(oldest.path, '.env'), 'SECRET=test\n');

    await createForThread();

    expectArchived(oldest, await ledgerRow(oldest.id));
    const ref = `refs/brainstrike/worktree-archive/${oldest.id}`;
    expect(git(repo, ['show', `${ref}:hello.ts`])).toBe('export const value = 2;\n');
    expect(git(repo, ['show', `${ref}:draft.ts`])).toBe('export const draft = true;\n');
    expect(git(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n')).not.toContain('.env');
    expect(git(repo, ['log', '--format=%s', 'bs/idle-00']).split('\n')).toContain(
      'work on its branch'
    );
  });

  it("does not count another repository's worktrees", async () => {
    const other = workspace.freshRepo('idle-cap-other');
    const others = await seedMany(16, other);
    const mine = await seedMany(15);

    await createForThread();

    for (const row of [...others, ...mine]) {
      expect((await ledgerRow(row.id)).archivedAt).toBeNull();
      expect(existsSync(row.path)).toBe(true);
    }
    expect(told).toEqual([]);
  });

  // Its notice is shown with a run: with no run to show it with, nothing is archived.
  it("runs no cap for the person's creation in a thread that has no run yet", async () => {
    const seeded = await seedMany(16);
    threads = [{ binding: null, hasRun: false, threadId: 'thread-1' }];

    await createForThread({ threadId: 'thread-1' }, 'before-first-send');

    for (const row of seeded) {
      expect((await ledgerRow(row.id)).archivedAt).toBeNull();
    }
    expect(told).toEqual([]);
  });

  it('runs no cap for a creation that names no thread, or a thread that is gone', async () => {
    const seeded = await seedMany(16);

    await createForThread({}, 'for-no-thread');
    await createForThread({ runId: 'run-9', threadId: 'deleted-thread' }, 'for-a-gone-thread');

    for (const row of seeded) {
      expect((await ledgerRow(row.id)).archivedAt).toBeNull();
    }
    expect(told).toEqual([]);
  });
});
