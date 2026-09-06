/**
 * Real git + real PGlite coverage for managed-worktree archive snapshots and
 * detached-worktree branch attachment.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runDrizzleMigrations as runMigrations } from '@brainstrike/db';
import type { GitInventory } from '@brainstrike/types';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runningBlockerCopy = vi.hoisted(() => ({ replacement: null as string | null }));

vi.mock('../../assistant-server/worktree-archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../assistant-server/worktree-archive')>();
  return {
    ...actual,
    inspectWorktreeSafety: async (
      ...args: Parameters<typeof actual.inspectWorktreeSafety>
    ): ReturnType<typeof actual.inspectWorktreeSafety> => {
      const result = await actual.inspectWorktreeSafety(...args);
      if (!(result.ok && result.value.threadIsRunning && runningBlockerCopy.replacement !== null)) {
        return result;
      }
      return {
        ok: true,
        value: { ...result.value, blockers: [runningBlockerCopy.replacement] },
      };
    },
  };
});

import type { GitCommandRunner } from '../../assistant-server/git-service';
import { captureArchiveSnapshot } from '../../assistant-server/worktree-archive';
import {
  createWorktreeLedger,
  type WorktreeLedgerDatabase,
} from '../../assistant-server/worktree-ledger';
import { execFileGitRunner } from '../../git-ipc-handlers';
import {
  asLedgerDatabase,
  buildTestService,
  createTestWorkspace,
  git,
} from './worktree-service.shared';

describe('WorktreeService archive and branch attachment (real git + real PGlite)', () => {
  let db: PGlite;
  let managedDirectory: string;
  let repo: string;
  const workspace = createTestWorkspace();

  const buildService = () => buildTestService({ db, managedDirectory, repo });

  /**
   * Seed a running run on `threadId` through the REAL relations (117/118).
   * These two cases used to `CREATE TABLE IF NOT EXISTS` a three-column
   * stand-in for `brainstrike_assistant_thread_runs`, back when that table was
   * bootstrap-only DDL the migration chain never created. The chain owns it
   * now, so the stand-in silently no-opped and its three-column INSERT met the
   * real table's NOT NULLs. The archive blocker reads a run's status for a
   * thread, so seeding the real row exercises it against the production column
   * set and its `mastra_threads` foreign key rather than a lookalike.
   */
  const seedRunningRun = async (threadId: string, runId: string): Promise<void> => {
    await db.query(
      `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
       VALUES ($1, 'workspace-archive', $2, NOW(), NOW())`,
      [threadId, `Thread ${threadId}`]
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_runs
         (id, resource_id, thread_id, provider, model, runtime_kind, status,
          started_at, created_at, updated_at)
       VALUES ($1, 'workspace-archive', $2, 'anthropic', 'test-model', 'hosted', 'running',
               NOW(), NOW(), NOW())`,
      [runId, threadId]
    );
  };

  beforeEach(async () => {
    runningBlockerCopy.replacement = null;
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
    await runMigrations(db);
    repo = workspace.freshRepo('archive-repo');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  describe('WorktreeService.archive', () => {
    it('captures an archive commit with no repository or global Git identity configured', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/no-git-identity' },
        createdBy: 'user',
        name: 'no-git-identity',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      git(repo, ['config', '--unset', 'user.email']);
      git(repo, ['config', '--unset', 'user.name']);
      const isolatedHome = workspace.freshTempDir('bst-no-git-identity-');
      const keys = [
        'GIT_AUTHOR_EMAIL',
        'GIT_AUTHOR_NAME',
        'GIT_COMMITTER_EMAIL',
        'GIT_COMMITTER_NAME',
        'HOME',
      ] as const;
      const original = new Map(keys.map((key) => [key, process.env[key]]));
      try {
        process.env['HOME'] = isolatedHome;
        for (const key of keys.slice(0, 4)) {
          Reflect.deleteProperty(process.env, key);
        }
        const snapshot = await captureArchiveSnapshot({
          cwd: created.value.worktree.path,
          run: execFileGitRunner,
          worktree: created.value.worktree,
        });

        expect(snapshot.ok).toBe(true);
        if (!snapshot.ok) {
          return;
        }
        expect(git(repo, ['show', '-s', '--format=%an <%ae>', snapshot.value]).trim()).toBe(
          'BrainStrike Worktree Archive <worktree-archive@brainstrike.local>'
        );
      } finally {
        for (const [key, value] of original) {
          if (value === undefined) {
            Reflect.deleteProperty(process.env, key);
          } else {
            process.env[key] = value;
          }
        }
      }
    });

    it('captures a snapshot ref even for a CLEAN worktree, then removes it', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/clean' },
        createdBy: 'user',
        name: 'clean',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const { worktree } = created.value;

      const archived = await service.archive({ worktreeId: worktree.id });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      expect(archived.value.snapshotRef).toBe(`refs/brainstrike/worktree-archive/${worktree.id}`);
      // The ref lives in the REPOSITORY, so it survives the worktree removal.
      expect(git(repo, ['rev-parse', '--verify', archived.value.snapshotRef]).trim()).toMatch(
        /^[0-9a-f]{40}$/u
      );
      expect(existsSync(worktree.path)).toBe(false);
      expect(archived.value.worktree.archivedAt).not.toBeNull();
    });

    it('REFUSES a dirty worktree without force, naming what is dirty', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/dirty' },
        createdBy: 'user',
        name: 'dirty',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      writeFileSync(path.join(created.value.worktree.path, 'scratch.ts'), 'export const x = 1;\n');

      const refused = await service.archive({ worktreeId: created.value.worktree.id });
      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.error).toBe(
        'This worktree has uncommitted changes. Archive anyway to keep a restorable snapshot, or commit them first.'
      );
      expect(existsSync(created.value.worktree.path)).toBe(true);
      const snapshotRef = `refs/brainstrike/worktree-archive/${created.value.worktree.id}`;
      expect(git(repo, ['rev-parse', '--verify', snapshotRef]).trim()).toMatch(/^[0-9a-f]{40}$/u);
      expect(git(repo, ['ls-tree', '-r', '--name-only', snapshotRef])).toContain('scratch.ts');
    });

    it('REFUSES an unpushed commit without force, naming the count', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/unpushed' },
        createdBy: 'user',
        name: 'unpushed',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      const wt = created.value.worktree.path;
      writeFileSync(path.join(wt, 'a.ts'), 'export const a = 1;\n');
      git(wt, ['add', '.']);
      git(wt, ['commit', '-m', 'local work']);

      const refused = await service.archive({ worktreeId: created.value.worktree.id });
      expect(refused.ok === false && refused.error).toBe(
        'This worktree has 1 commit that is not on any remote. Archive anyway to keep a restorable snapshot, or push it first.'
      );
    });

    it('snapshots a deleted-base worktree before refusal and allows force to override', async () => {
      git(repo, ['branch', 'deleted-base']);
      const service = buildService();
      const created = await service.create({
        baseRef: 'deleted-base',
        branch: { name: 'bs/deleted-base' },
        createdBy: 'user',
        name: 'deleted-base',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      git(repo, ['branch', '-D', 'deleted-base']);
      const snapshotRef = `refs/brainstrike/worktree-archive/${created.value.worktree.id}`;

      const refused = await service.archive({ worktreeId: created.value.worktree.id });

      expect(refused).toEqual({
        error:
          "this worktree's base ref `deleted-base` no longer exists, so unpushed commits cannot be assessed",
        ok: false,
      });
      expect(git(repo, ['rev-parse', '--verify', snapshotRef]).trim()).toMatch(/^[0-9a-f]{40}$/u);
      expect(existsSync(created.value.worktree.path)).toBe(true);

      const forced = await service.archive({ force: true, worktreeId: created.value.worktree.id });
      expect(forced.ok).toBe(true);
      expect(existsSync(created.value.worktree.path)).toBe(false);
    });

    it('ARCHIVES a dirty worktree with force, and the snapshot contains the dirty file', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/forced' },
        createdBy: 'user',
        name: 'forced',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      writeFileSync(path.join(created.value.worktree.path, 'scratch.ts'), 'export const x = 1;\n');

      const archived = await service.archive({
        force: true,
        worktreeId: created.value.worktree.id,
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      const listed = git(repo, ['ls-tree', '-r', '--name-only', archived.value.snapshotRef]);
      expect(listed).toContain('scratch.ts');
    });

    it('captures tracked deletions in the archive snapshot', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/deleted-file' },
        createdBy: 'user',
        name: 'deleted-file',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      rmSync(path.join(created.value.worktree.path, 'hello.ts'));

      const archived = await service.archive({
        force: true,
        worktreeId: created.value.worktree.id,
      });

      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      expect(git(repo, ['ls-tree', '-r', '--name-only', archived.value.snapshotRef])).not.toContain(
        'hello.ts'
      );
    });

    it('preserves out-of-cone tracked files in a sparse-checkout archive snapshot', async () => {
      mkdirSync(path.join(repo, 'included'), { recursive: true });
      mkdirSync(path.join(repo, 'excluded'), { recursive: true });
      writeFileSync(path.join(repo, 'included', 'keep.ts'), 'export const keep = true;\n');
      writeFileSync(
        path.join(repo, 'excluded', 'out-of-cone.ts'),
        'export const outside = true;\n'
      );
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-m', 'add sparse-checkout fixtures']);
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/sparse-archive' },
        createdBy: 'user',
        name: 'sparse-archive',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const worktreePath = created.value.worktree.path;
      git(worktreePath, ['sparse-checkout', 'init', '--cone']);
      git(worktreePath, ['sparse-checkout', 'set', 'included']);
      expect(existsSync(path.join(worktreePath, 'excluded', 'out-of-cone.ts'))).toBe(false);
      expect(git(worktreePath, ['status', '--porcelain'])).toBe('');

      const archived = await service.archive({ worktreeId: created.value.worktree.id });

      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      expect(git(repo, ['ls-tree', '-r', '--name-only', archived.value.snapshotRef])).toContain(
        'excluded/out-of-cone.ts'
      );
    });

    it('does NOT capture ignored files (node_modules stays out of the snapshot)', async () => {
      const service = buildService();
      writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
      git(repo, ['add', '.gitignore']);
      git(repo, ['commit', '-m', 'ignore deps']);
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/ignored' },
        createdBy: 'user',
        name: 'ignored',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      mkdirSync(path.join(created.value.worktree.path, 'node_modules'), { recursive: true });
      writeFileSync(
        path.join(created.value.worktree.path, 'node_modules', 'big.js'),
        'x'.repeat(1000)
      );

      const archived = await service.archive({
        force: true,
        worktreeId: created.value.worktree.id,
      });
      if (!archived.ok) {
        return;
      }
      expect(git(repo, ['ls-tree', '-r', '--name-only', archived.value.snapshotRef])).not.toContain(
        'node_modules'
      );
    });

    it('REFUSES while the owning thread has a running run, even with force', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/busy' },
        createdBy: 'user',
        name: 'busy',
        rootId: 'r-1',
        threadId: 't-busy',
      });
      if (!created.ok) {
        return;
      }
      await seedRunningRun('t-busy', 'run-1');
      const refused = await service.archive({
        force: true,
        worktreeId: created.value.worktree.id,
      });
      expect(refused.ok === false && refused.error).toBe(
        'A run is active in this worktree. Wait for it to finish, or stop it first.'
      );
    });

    it('REFUSES force structurally when a running-run blocker copy is reworded', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/busy-reworded' },
        createdBy: 'user',
        name: 'busy-reworded',
        rootId: 'r-1',
        threadId: 't-busy-reworded',
      });
      if (!created.ok) {
        return;
      }
      await seedRunningRun('t-busy-reworded', 'run-reworded');
      runningBlockerCopy.replacement = 'Running-work copy deliberately changed.';

      const refused = await service.archive({
        force: true,
        worktreeId: created.value.worktree.id,
      });

      expect(refused).toEqual({
        error: 'Running-work copy deliberately changed.',
        ok: false,
      });
      expect(existsSync(created.value.worktree.path)).toBe(true);
    });

    it('REFUSES a worktree carrying an inventory lock reason', async () => {
      const created = await buildService().create({
        baseRef: 'main',
        branch: { name: 'bs/inventory-locked' },
        createdBy: 'user',
        name: 'inventory-locked',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      const { worktree } = created.value;
      const inventory = {
        errors: [],
        repositories: [
          {
            identity: { gitCommonDir: worktree.repoCommonDir, repositoryRoot: repo },
            worktrees: [
              {
                bare: false,
                branch: worktree.branch,
                containment: ['r-1'],
                current: false,
                detached: false,
                head: git(worktree.path, ['rev-parse', 'HEAD']).trim(),
                lockedReason: 'maintenance window',
                name: 'inventory-locked',
                path: worktree.path,
                provenance: 'scanned',
                prunableReason: null,
                trust: 'validated',
                trustReason: null,
              },
            ],
          },
        ],
      } satisfies GitInventory;
      const service = buildTestService(
        { db, managedDirectory, repo },
        { resolveInventory: () => Promise.resolve(inventory) }
      );

      const refused = await service.archive({ worktreeId: worktree.id });

      expect(refused).toEqual({
        error: 'This worktree is locked: maintenance window',
        ok: false,
      });
      expect(existsSync(worktree.path)).toBe(true);
    });

    it('names the surviving snapshot when the post-removal ledger write fails', async () => {
      const created = await buildService().create({
        baseRef: 'main',
        branch: { name: 'bs/archive-ledger-failure' },
        createdBy: 'user',
        name: 'archive-ledger-failure',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      const { worktree } = created.value;
      const snapshotRef = `refs/brainstrike/worktree-archive/${worktree.id}`;
      const underlying = asLedgerDatabase(db);
      const failingLedger: WorktreeLedgerDatabase = {
        async query(sql, params) {
          if (sql.includes('SET archived_at = NOW()')) {
            throw new Error('archive ledger unavailable');
          }
          return await underlying.query(sql, params);
        },
      };
      const service = buildTestService(
        { db, managedDirectory, repo },
        { getDatabase: () => Promise.resolve(failingLedger) }
      );

      const failed = await service.archive({ worktreeId: worktree.id });

      expect(failed.ok).toBe(false);
      expect(failed.ok === false && failed.error).toContain(`your snapshot is at ${snapshotRef}`);
      expect(existsSync(worktree.path)).toBe(false);
      expect(git(repo, ['rev-parse', '--verify', snapshotRef]).trim()).toMatch(/^[0-9a-f]{40}$/u);
      const ledger = createWorktreeLedger(() => Promise.resolve(underlying));
      await expect(ledger.get(worktree.id)).resolves.toMatchObject({ archivedAt: null });
    });

    it('leaves the ledger row UNARCHIVED when the removal itself fails', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/locked' },
        createdBy: 'user',
        name: 'locked',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }
      git(repo, ['worktree', 'lock', created.value.worktree.path]);
      const refused = await service.archive({ worktreeId: created.value.worktree.id });
      expect(refused.ok).toBe(false);
      const row = await db.query<{ archived_at: Date | null }>(
        'SELECT archived_at FROM brainstrike_worktrees WHERE id = $1',
        [created.value.worktree.id]
      );
      expect(row.rows[0]?.archived_at).toBeNull();
    });
  });

  describe('WorktreeService.restore', () => {
    it('refuses to restore when the archived branch has moved', async () => {
      const service = buildService();
      const branch = 'bs/restore-moved';
      const created = await service.create({
        baseRef: 'main',
        branch: { name: branch },
        createdBy: 'user',
        name: 'restore-moved',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const archived = await service.archive({ worktreeId: created.value.worktree.id });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      const expectedTip = git(repo, ['rev-parse', `${archived.value.snapshotRef}^`]).trim();
      writeFileSync(path.join(repo, 'advanced.txt'), 'branch advanced after archive\n');
      git(repo, ['add', 'advanced.txt']);
      git(repo, ['commit', '-m', 'advance archived branch out of band']);
      const advancedTip = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['update-ref', `refs/heads/${branch}`, advancedTip, expectedTip]);

      const restored = await service.restore({ worktreeId: created.value.worktree.id });

      expect(restored).toEqual({
        error: `"${branch}" has moved since this worktree was archived (now ${advancedTip.slice(0, 7)}, snapshot expects ${expectedTip.slice(0, 7)}) — rename or move the branch first.`,
        ok: false,
      });
      expect(git(repo, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(advancedTip);
      expect(existsSync(created.value.worktree.path)).toBe(false);
    });

    it('restores an unchanged branch by checking it out without resetting it', async () => {
      const branch = 'bs/restore-unchanged';
      let worktreeAddArgs: readonly string[] | null = null;
      const recordWorktreeAdd: GitCommandRunner = async (params) => {
        const worktreeIndex = params.args.indexOf('worktree');
        if (worktreeIndex >= 0 && params.args[worktreeIndex + 1] === 'add') {
          worktreeAddArgs = params.args.slice(worktreeIndex);
        }
        return await execFileGitRunner(params);
      };
      const service = buildTestService({ db, managedDirectory, repo }, { run: recordWorktreeAdd });
      const created = await service.create({
        baseRef: 'main',
        branch: { name: branch },
        createdBy: 'user',
        name: 'restore-unchanged',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const archived = await service.archive({ worktreeId: created.value.worktree.id });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      const branchTipBeforeRestore = git(repo, ['rev-parse', `refs/heads/${branch}`]).trim();

      const restored = await service.restore({ worktreeId: created.value.worktree.id });

      expect(restored.ok).toBe(true);
      expect(worktreeAddArgs).toEqual([
        'worktree',
        'add',
        '--',
        created.value.worktree.path,
        branch,
      ]);
      expect(git(repo, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(branchTipBeforeRestore);
      expect(git(created.value.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        branch
      );
    });

    it('recreates a missing archived branch at the snapshot parent', async () => {
      const service = buildService();
      const branch = 'bs/restore-missing-branch';
      const created = await service.create({
        baseRef: 'main',
        branch: { name: branch },
        createdBy: 'user',
        name: 'restore-missing-branch',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const archived = await service.archive({ worktreeId: created.value.worktree.id });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      const expectedTip = git(repo, ['rev-parse', `${archived.value.snapshotRef}^`]).trim();
      git(repo, ['update-ref', '-d', `refs/heads/${branch}`]);

      const restored = await service.restore({ worktreeId: created.value.worktree.id });

      expect(restored.ok).toBe(true);
      expect(git(repo, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(expectedTip);
      expect(git(created.value.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        branch
      );
    });

    it('restores a detached worktree without attaching a branch', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { detached: true },
        createdBy: 'user',
        name: 'restore-detached',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const archived = await service.archive({ worktreeId: created.value.worktree.id });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }

      const restored = await service.restore({ worktreeId: created.value.worktree.id });

      expect(restored.ok).toBe(true);
      const symbolicHead = await execFileGitRunner({
        args: ['symbolic-ref', '--quiet', 'HEAD'],
        cwd: created.value.worktree.path,
        timeoutMs: 5000,
      });
      expect(symbolicHead.exitCode).toBe(1);
      expect(symbolicHead.stdout).toBe('');
    });

    it('replays archived dirty content into the original worktree path', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/restore-dirty' },
        createdBy: 'user',
        name: 'restore-dirty',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const dirtyPath = path.join(created.value.worktree.path, 'dirty.txt');
      writeFileSync(dirtyPath, 'dirty content restored exactly\n');
      const archived = await service.archive({
        force: true,
        worktreeId: created.value.worktree.id,
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }

      const restored = await service.restore({ worktreeId: created.value.worktree.id });

      expect(restored.ok).toBe(true);
      if (!restored.ok) {
        return;
      }
      expect(existsSync(created.value.worktree.path)).toBe(true);
      expect(readFileSync(dirtyPath, 'utf8')).toBe('dirty content restored exactly\n');
      expect(restored.value.worktree.archivedAt).toBeNull();
      expect(git(repo, ['rev-parse', '--verify', archived.value.snapshotRef]).trim()).toMatch(
        /^[0-9a-f]{40}$/u
      );
    });

    it('refuses a worktree that was never archived', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/restore-active' },
        createdBy: 'user',
        name: 'restore-active',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      await expect(service.restore({ worktreeId: created.value.worktree.id })).resolves.toEqual({
        error: 'That worktree is not archived — there is nothing to restore.',
        ok: false,
      });
    });

    it('refuses when the archive snapshot ref no longer exists', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/restore-missing-snapshot' },
        createdBy: 'user',
        name: 'restore-missing-snapshot',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const archived = await service.archive({ worktreeId: created.value.worktree.id });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      git(repo, ['update-ref', '-d', archived.value.snapshotRef]);

      const refused = await service.restore({ worktreeId: created.value.worktree.id });

      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.error).toContain('snapshot');
    });

    it('refuses when the original worktree path is occupied', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/restore-occupied' },
        createdBy: 'user',
        name: 'restore-occupied',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const archived = await service.archive({ worktreeId: created.value.worktree.id });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      mkdirSync(created.value.worktree.path, { recursive: true });
      writeFileSync(path.join(created.value.worktree.path, 'occupied.txt'), 'occupied\n');

      const refused = await service.restore({ worktreeId: created.value.worktree.id });

      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.error).toContain(created.value.worktree.path);
    });

    it('removes the recreated worktree when replaying the snapshot fails', async () => {
      const service = buildService();
      const branch = 'bs/restore-compensation';
      const created = await service.create({
        baseRef: 'main',
        branch: { name: branch },
        createdBy: 'user',
        name: 'restore-compensation',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      writeFileSync(path.join(created.value.worktree.path, 'dirty.txt'), 'must survive retry\n');
      const archived = await service.archive({
        force: true,
        worktreeId: created.value.worktree.id,
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        return;
      }
      const branchTipBeforeRestore = git(repo, ['rev-parse', `refs/heads/${branch}`]).trim();
      const failSnapshotReplay: GitCommandRunner = async (params) => {
        if (
          params.args.includes('restore') &&
          params.args.includes(`--source=${archived.value.snapshotRef}`)
        ) {
          return {
            exitCode: 128,
            stderr: 'forced snapshot replay failure',
            stdout: '',
            timedOut: false,
          };
        }
        return await execFileGitRunner(params);
      };
      const restoreService = buildTestService(
        { db, managedDirectory, repo },
        { run: failSnapshotReplay }
      );

      const failed = await restoreService.restore({ worktreeId: created.value.worktree.id });

      expect(failed.ok).toBe(false);
      expect(failed.ok === false && failed.error).toContain('forced snapshot replay failure');
      expect(existsSync(created.value.worktree.path)).toBe(false);
      expect(git(repo, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(branchTipBeforeRestore);
      const ledger = createWorktreeLedger(() => Promise.resolve(asLedgerDatabase(db)));
      await expect(ledger.get(created.value.worktree.id)).resolves.toMatchObject({
        archivedAt: expect.any(String),
        archiveSnapshotRef: archived.value.snapshotRef,
      });
    });
  });

  describe('WorktreeService.createBranchHere', () => {
    it('attaches a new branch to a detached managed worktree and updates the ledger', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { detached: true },
        createdBy: 'user',
        name: 'detached-success',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      const attached = await service.createBranchHere({
        branch: 'bs/attached',
        worktreeId: created.value.worktree.id,
      });
      expect(attached.ok).toBe(true);
      if (!attached.ok) {
        return;
      }
      expect(attached.value.branch).toBe('bs/attached');
      expect(git(attached.value.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        'bs/attached'
      );
      const ledger = createWorktreeLedger(() => Promise.resolve(asLedgerDatabase(db)));
      await expect(ledger.get(attached.value.id)).resolves.toMatchObject({ branch: 'bs/attached' });
    });

    it('refuses an existing local branch without mutating the detached worktree', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { detached: true },
        createdBy: 'user',
        name: 'detached-existing',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      const refused = await service.createBranchHere({
        branch: 'main',
        worktreeId: created.value.worktree.id,
      });
      expect(refused).toEqual({ error: 'local branch "main" already exists', ok: false });
      expect(git(created.value.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        'HEAD'
      );
      const ledger = createWorktreeLedger(() => Promise.resolve(asLedgerDatabase(db)));
      await expect(ledger.get(created.value.worktree.id)).resolves.toMatchObject({ branch: null });
    });

    it('refuses to create a branch when the managed worktree is already attached', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/already-attached' },
        createdBy: 'user',
        name: 'already-attached',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }

      const refused = await service.createBranchHere({
        branch: 'bs/must-not-replace',
        worktreeId: created.value.worktree.id,
      });

      expect(refused).toEqual({
        error: `Managed worktree "${created.value.worktree.id}" is attached to branch "bs/already-attached"; createBranchHere requires a detached worktree.`,
        ok: false,
      });
      expect(git(created.value.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        'bs/already-attached'
      );
      const ledger = createWorktreeLedger(() => Promise.resolve(asLedgerDatabase(db)));
      await expect(ledger.get(created.value.worktree.id)).resolves.toMatchObject({
        branch: 'bs/already-attached',
      });
    });

    it('refuses an unknown worktree id', async () => {
      const service = buildService();
      await expect(
        service.createBranchHere({ branch: 'bs/nope', worktreeId: 'unknown-worktree' })
      ).resolves.toEqual({
        error: 'Managed worktree "unknown-worktree" is not active.',
        ok: false,
      });
    });
  });
});
