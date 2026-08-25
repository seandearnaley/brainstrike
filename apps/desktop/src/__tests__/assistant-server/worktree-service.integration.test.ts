/**
 * Real git + real PGlite. The whole point of this suite is that `git worktree
 * add` actually runs and the ledger actually persists — a mocked runner would
 * prove only that the arguments were assembled.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDrizzleMigrations as runMigrations } from '@brainstrike/db';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeService } from '../../assistant-server/worktree-service';
import { execFileGitRunner } from '../../git-ipc-handlers';

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function freshRepo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `bst-wt-${label}-`));
  tempDirs.push(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@brainstrike.invalid']);
  git(dir, ['config', 'user.name', 'BrainStrike Test']);
  writeFileSync(path.join(dir, 'hello.ts'), 'export const value = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

function freshManagedDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bst-managed-'));
  tempDirs.push(dir);
  return dir;
}

describe('WorktreeService (real git + real PGlite)', () => {
  let db: PGlite;
  let repo: string;
  let managedDirectory: string;

  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    createWorktreeService({
      getDatabase: () => Promise.resolve(db as unknown as { query: PGlite['query'] }),
      homeDirectory: managedDirectory,
      readSettings: () =>
        Promise.resolve({ isDefaultDirectory: true, managedDirectory, setupCommand: null }),
      resolveInventory: () => Promise.resolve({ errors: [], repositories: [] }),
      resolveRootCwd: (rootId: string) =>
        Promise.resolve(
          rootId === 'r-1'
            ? { ok: true as const, value: repo }
            : { error: 'unknown root', ok: false as const }
        ),
      resolveRootPaths: () => Promise.resolve([{ id: 'r-1', path: repo }]),
      run: execFileGitRunner,
      runSetup: () =>
        Promise.resolve({
          copiedPaths: [],
          output: '',
          reason: null,
          status: 'none' as const,
          truncated: false,
        }),
      ...overrides,
    });

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
    await runMigrations(db);
    repo = freshRepo('repo');
    managedDirectory = freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('creates a branch-on-create worktree on disk and records it in the ledger', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/bright-fox' },
      createdBy: 'user',
      name: 'bright-fox',
      rootId: 'r-1',
      threadId: 't-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const { worktree } = created.value;
    expect(worktree.branch).toBe('bs/bright-fox');
    expect(worktree.createdBy).toBe('user');
    expect(worktree.threadId).toBe('t-1');
    // The directory really exists and really is a linked worktree.
    expect(readFileSync(path.join(worktree.path, 'hello.ts'), 'utf8')).toContain(
      'export const value'
    );
    expect(git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('bs/bright-fox');
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM brainstrike_worktrees WHERE archived_at IS NULL'
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('creates a DETACHED worktree with a null branch [D2]', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { detached: true },
      createdBy: 'user',
      name: 'detached-one',
      rootId: 'r-1',
    });
    expect(created.ok && created.value.worktree.branch).toBeNull();
    if (created.ok) {
      expect(git(created.value.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        'HEAD'
      );
    }
  });

  it('refuses a branch name that already exists rather than reusing it', async () => {
    const service = buildService();
    await service.create({
      baseRef: 'main',
      branch: { name: 'bs/taken' },
      createdBy: 'user',
      name: 'taken-one',
      rootId: 'r-1',
    });
    const second = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/taken' },
      createdBy: 'user',
      name: 'taken-two',
      rootId: 'r-1',
    });
    expect(second).toEqual({ error: 'local branch "bs/taken" already exists', ok: false });
  });

  it('refuses a directory name already taken by a live ledger row', async () => {
    const service = buildService();
    await service.create({
      baseRef: 'main',
      branch: { name: 'bs/one' },
      createdBy: 'user',
      name: 'same-name',
      rootId: 'r-1',
    });
    const second = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/two' },
      createdBy: 'user',
      name: 'same-name',
      rootId: 'r-1',
    });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toContain('already exists');
  });

  it('REFUSES a managed directory inside a granted root, naming the root', async () => {
    const service = buildService({
      readSettings: () =>
        Promise.resolve({
          isDefaultDirectory: false,
          managedDirectory: path.join(repo, 'wt'),
          setupCommand: null,
        }),
    });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/inside' },
      createdBy: 'user',
      name: 'inside',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(false);
    expect(created.ok === false && created.error).toContain(
      'Managed worktrees must not live inside the granted folder'
    );
  });

  it('authorizes ONLY a live ledger path under the managed directory', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/grant' },
      createdBy: 'user',
      name: 'grant-me',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await expect(service.isManagedWorktreePath(created.value.worktree.path)).resolves.toBe(true);
    await expect(service.isManagedWorktreePath(repo)).resolves.toBe(false);
    await expect(
      service.isManagedWorktreePath(path.join(managedDirectory, 'not-a-row'))
    ).resolves.toBe(false);
  });

  it('reports a ledger row missing on disk as unvalidated, with the reason', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/ghost' },
      createdBy: 'user',
      name: 'ghost',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    rmSync(created.value.worktree.path, { force: true, recursive: true });
    const listed = await service.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const ghost = listed.value.find((entry) => entry.id === created.value.worktree.id);
    expect(ghost).toMatchObject({
      provenance: 'agent-reported',
      trust: 'unvalidated',
      trustReason: 'missing on disk',
      usable: false,
    });
    expect(ghost?.disabledReason).toBe('Worktree is missing on disk — restore it or archive it.');
  });
});
