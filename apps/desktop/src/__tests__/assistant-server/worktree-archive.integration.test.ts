/**
 * Real git + real PGlite coverage for managed-worktree archive snapshots and
 * detached-worktree branch attachment.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runDrizzleMigrations as runMigrations } from '@brainstrike/db';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeLedger } from '../../assistant-server/worktree-ledger';
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

  beforeEach(async () => {
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
      await db.query(`
        CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_runs (
          id text PRIMARY KEY, thread_id text NOT NULL, status text NOT NULL
        )`);
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
      await db.query(
        "INSERT INTO brainstrike_assistant_thread_runs (id, thread_id, status) VALUES ('run-1','t-busy','running')"
      );
      const refused = await service.archive({
        force: true,
        worktreeId: created.value.worktree.id,
      });
      expect(refused.ok === false && refused.error).toBe(
        'A run is active in this worktree. Wait for it to finish, or stop it first.'
      );
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
