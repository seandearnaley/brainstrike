/**
 * Real git + real PGlite. The whole point of this suite is that `git worktree
 * add` actually runs and the ledger actually persists — a mocked runner would
 * prove only that the arguments were assembled.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDrizzleMigrations as runMigrations } from '@brainstrike/db';
import type { GitInventory } from '@brainstrike/types';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorktreeLedger,
  type WorktreeLedgerDatabase,
} from '../../assistant-server/worktree-ledger';
import { repositorySlug } from '../../assistant-server/worktree-paths';
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

function asLedgerDatabase(database: PGlite): WorktreeLedgerDatabase {
  return {
    async query(sql, params) {
      const result = await database.query(sql, params);
      return { rows: result.rows };
    },
  };
}

describe('WorktreeService (real git + real PGlite)', () => {
  let db: PGlite;
  let repo: string;
  let managedDirectory: string;

  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    createWorktreeService({
      getDatabase: () => Promise.resolve(asLedgerDatabase(db)),
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
    expect(worktree.id[14]).toBe('7');
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
    const first = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/one' },
      createdBy: 'user',
      name: 'same-name',
      rootId: 'r-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/two' },
      createdBy: 'user',
      name: 'same-name',
      rootId: 'r-1',
    });
    expect(second.ok).toBe(false);
    expect(second).toEqual({
      error: `A worktree at "${first.value.worktree.path}" already exists.`,
      ok: false,
    });
  });

  it('removes the git worktree when ledger insert loses a duplicate-path race', async () => {
    const repoRoot = realpathSync(repo);
    const commonDir = realpathSync(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    );
    const target = path.join(
      realpathSync(managedDirectory),
      repositorySlug(repoRoot, commonDir),
      'ledger-race'
    );
    const ledger = createWorktreeLedger(() => Promise.resolve(asLedgerDatabase(db)));
    await ledger.insert({
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: 'bs/preexisting-ledger-row',
      createdAt: new Date().toISOString(),
      createdBy: 'user',
      id: '01993a12-0000-7000-8000-000000000001',
      path: target,
      repoCommonDir: commonDir,
      runId: null,
      setupOutput: null,
      setupStatus: 'none',
      threadId: null,
    });

    let hidDuplicateFromPreflight = false;
    const underlying = asLedgerDatabase(db);
    const staleReadDatabase: WorktreeLedgerDatabase = {
      async query(sql, params) {
        if (!hidDuplicateFromPreflight && sql.includes('WHERE path = $1')) {
          hidDuplicateFromPreflight = true;
          return { rows: [] };
        }
        return underlying.query(sql, params);
      },
    };
    const service = buildService({
      getDatabase: () => Promise.resolve(staleReadDatabase),
    });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/ledger-race' },
      createdBy: 'user',
      name: 'ledger-race',
      rootId: 'r-1',
    });

    expect(created.ok).toBe(false);
    expect(created.ok === false && created.error).toMatch(/duplicate key|unique/iu);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${target}`);
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
    expect(existsSync(path.join(repo, 'wt'))).toBe(false);
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
    mkdirSync(path.join(managedDirectory, 'not-a-row'), { recursive: true });
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
    expect(ghost?.repositoryRoot).toBe(realpathSync(repo));
  });

  it('joins a realistic inventory with ledger provenance, labels, gates, and containing root ids', async () => {
    const created = await buildService().create({
      baseRef: 'main',
      branch: { name: 'bs/inventory-both' },
      createdBy: 'agent',
      name: 'inventory-both',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const externalPath = path.join(tmpdir(), '.codex', 'worktrees', 'external-one');
    const prunablePath = path.join(tmpdir(), 'prunable-one');
    const lockedPath = path.join(repo, 'locked-one');
    const untrustedPath = path.join(tmpdir(), 'untrusted-one');
    const descriptor = (
      overrides: Partial<GitInventory['repositories'][number]['worktrees'][number]>
    ) => ({
      bare: false,
      branch: 'main',
      containment: ['r-container'],
      current: false,
      detached: false,
      head: '0123456789012345678901234567890123456789',
      lockedReason: null,
      name: 'fixture',
      path: created.value.worktree.path,
      provenance: 'scanned' as const,
      prunableReason: null,
      trust: 'validated' as const,
      trustReason: null,
      ...overrides,
    });
    const inventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: created.value.worktree.repoCommonDir, repositoryRoot: repo },
          worktrees: [
            descriptor({}),
            descriptor({
              containment: 'outside-roots',
              name: 'external-one',
              path: externalPath,
            }),
            descriptor({
              containment: 'outside-roots',
              name: 'prunable-one',
              path: prunablePath,
              prunableReason: 'gitdir file points to non-existent location',
              trust: 'unvalidated',
              trustReason: 'worktree path could not be resolved',
            }),
            descriptor({
              lockedReason: 'maintenance',
              name: 'locked-one',
              path: lockedPath,
            }),
            descriptor({
              containment: 'outside-roots',
              name: 'untrusted-one',
              path: untrustedPath,
              trust: 'unvalidated',
              trustReason: null,
            }),
          ],
        },
      ],
    } satisfies GitInventory;
    const listed = await buildService({
      resolveInventory: () => Promise.resolve(inventory),
      resolveRootPaths: () =>
        Promise.resolve([
          { id: 'r-1', path: repo },
          { id: 'r-container', path: managedDirectory },
        ]),
    }).list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }

    expect(listed.value.find((entry) => entry.path === created.value.worktree.path)).toMatchObject({
      managed: true,
      provenance: 'both',
      rootId: 'r-container',
      usable: true,
    });
    expect(listed.value.find((entry) => entry.path === externalPath)).toMatchObject({
      externalTool: 'codex',
      managed: false,
      provenance: 'scanned',
      remedy: 'grant-access',
      usable: false,
    });
    expect(listed.value.find((entry) => entry.path === prunablePath)).toMatchObject({
      disabledReason: 'Worktree is prunable: gitdir file points to non-existent location',
      usable: false,
    });
    expect(listed.value.find((entry) => entry.path === lockedPath)).toMatchObject({
      disabledReason: 'Locked: maintenance',
      usable: false,
    });
    expect(listed.value.find((entry) => entry.path === untrustedPath)).toMatchObject({
      disabledReason: 'This worktree could not be verified against its own .git.',
      usable: false,
    });
  });

  it.each([
    ['baseRef', null],
    ['repoCommonDir', 42],
    ['createdBy', 'robot'],
    ['setupStatus', 'maybe'],
    ['branch', 42],
  ])('rejects a malformed ledger %s value instead of coercing it', async (field, value) => {
    const row: Record<string, unknown> = {
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: null,
      createdAt: new Date(),
      createdBy: 'user',
      id: '01993a12-0000-7000-8000-000000000002',
      path: '/worktree',
      repoCommonDir: '/repo/.git',
      runId: null,
      setupOutput: null,
      setupStatus: 'none',
      threadId: null,
      [field]: value,
    };
    const ledger = createWorktreeLedger(() =>
      Promise.resolve({ query: () => Promise.resolve({ rows: [row] }) })
    );

    await expect(ledger.get(row['id'] as string)).rejects.toThrow(
      'Malformed brainstrike_worktrees row'
    );
  });
});
