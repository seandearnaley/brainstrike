// @vitest-environment node

/**
 * Real git + real SQLite. The whole point of this suite is that `git worktree
 * add` actually runs and the ledger actually persists — a mocked runner would
 * prove only that the arguments were assembled.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore, type WorktreeLedgerPort } from '@brainstrike/state-store';
import type { GitInventory } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerErrorSpy = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      return { ...real, error: loggerErrorSpy };
    },
  };
});

import { createWorktreeLedger } from '../../assistant-server/worktree-ledger';
import { repositorySlug } from '../../assistant-server/worktree-paths';
import type { createWorktreeService } from '../../assistant-server/worktree-service';
import {
  asLedgerStore,
  buildTestService,
  createTestWorkspace,
  git,
} from './worktree-service.shared';

describe('WorktreeService (real git + real SQLite)', () => {
  let db: StateStore;
  let repo: string;
  let managedDirectory: string;
  const workspace = createTestWorkspace();

  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    buildTestService({ db, managedDirectory, repo }, overrides);

  beforeEach(async () => {
    loggerErrorSpy.mockClear();
    db = await StateStore.open(workspace.freshTempDir('bst-worktree-state-'));
    repo = workspace.freshRepo('repo');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it('archives a vanished worktree with an empty parentless snapshot and prunes its registration', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/vanished-archive' },
      createdBy: 'user',
      name: 'vanished-archive',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const worktreePath = created.value.worktree.path;
    const porcelainPath = worktreePath.split(path.sep).join('/');
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(porcelainPath);
    rmSync(worktreePath, { force: true, recursive: true });

    const archived = await service.archive({ worktreeId: created.value.worktree.id });

    expect(archived.ok).toBe(true);
    if (!archived.ok) {
      return;
    }
    expect(archived.value.worktree.archivedAt).not.toBeNull();
    expect(archived.value.worktree.archiveSnapshotRef).toBe(archived.value.snapshotRef);
    expect(
      git(repo, ['rev-parse', '--verify', `${archived.value.snapshotRef}^{commit}`]).trim()
    ).toMatch(/^[0-9a-f]{40}$/u);
    expect(git(repo, ['ls-tree', '-r', '--name-only', archived.value.snapshotRef])).toBe('');
    expect(() => git(repo, ['rev-parse', '--verify', `${archived.value.snapshotRef}^`])).toThrow();
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(porcelainPath);
  });

  it('refuses to restore an archive captured after its worktree vanished', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/vanished-restore' },
      createdBy: 'user',
      name: 'vanished-restore',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    rmSync(created.value.worktree.path, { force: true, recursive: true });
    const archived = await service.archive({ worktreeId: created.value.worktree.id });
    expect(archived.ok).toBe(true);
    if (!archived.ok) {
      return;
    }

    await expect(service.restore({ worktreeId: created.value.worktree.id })).resolves.toEqual({
      error:
        'This worktree was archived while missing on disk — there is nothing to restore. Create a new worktree instead.',
      ok: false,
    });
    const ledger = createWorktreeLedger(
      () => Promise.resolve(asLedgerStore(db)),
      async () => false
    );
    await expect(ledger.get(created.value.worktree.id)).resolves.toMatchObject({
      archivedAt: expect.any(String),
      archiveSnapshotRef: archived.value.snapshotRef,
    });
    expect(existsSync(created.value.worktree.path)).toBe(false);
  });

  it('lists active managed paths without consulting git inventory or workspace roots', async () => {
    const commonDir = realpathSync(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    );
    const ledger = createWorktreeLedger(
      () => Promise.resolve(asLedgerStore(db)),
      async () => false
    );
    await ledger.insert({
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: 'bs/active',
      createdAt: new Date().toISOString(),
      createdBy: 'user',
      id: '01993a12-0000-7000-8000-000000000011',
      path: '/managed/active',
      repoCommonDir: commonDir,
      runId: null,
      setupOutput: null,
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
    });
    await ledger.insert({
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: 'bs/archived',
      createdAt: new Date().toISOString(),
      createdBy: 'user',
      id: '01993a12-0000-7000-8000-000000000012',
      path: '/managed/archived',
      repoCommonDir: commonDir,
      runId: null,
      setupOutput: null,
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
    });
    await ledger.markArchived(
      '01993a12-0000-7000-8000-000000000012',
      'refs/brainstrike/worktree-archive/archived'
    );
    const service = buildService({
      resolveInventory: () => Promise.reject(new Error('inventory must not be read')),
      resolveRootPaths: () => Promise.reject(new Error('roots must not be read')),
    });

    await expect(service.listManagedPaths()).resolves.toEqual({
      ok: true,
      value: [{ id: '01993a12-0000-7000-8000-000000000011', path: '/managed/active' }],
    });
  });

  it('keeps repository setup execution reachable only from granted-root creation', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/assistant-server/worktree-service.ts'),
      'utf8'
    );

    expect(source.match(/deps\.runSetup\(/gu)).toHaveLength(1);
    expect(source.match(/runSetupSafely\(/gu)).toHaveLength(2);
    expect(source).toMatch(
      /async function createUnserialized[\s\S]*?resolveRepositoryContext\(params\.rootId\)[\s\S]*?runSetupSafely\(\{/u
    );
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
    expect((await db.worktreeLedger({ operation: 'list-active' })).rows).toHaveLength(1);
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

  it('resolves the create parent and suggests a name outside the live ledger set', async () => {
    const service = buildService();
    const first = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/bright-fox' },
      createdBy: 'user',
      name: 'bright-fox',
      rootId: 'r-1',
    });
    const second = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/quiet-otter' },
      createdBy: 'user',
      name: 'quiet-otter',
      rootId: 'r-1',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) {
      return;
    }

    const context = await service.createContext({ rootId: 'r-1' });

    expect(context.ok).toBe(true);
    if (!context.ok) {
      return;
    }
    const commonDir = realpathSync(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    );
    const expectedParent = path.join(
      managedDirectory,
      repositorySlug(realpathSync(repo), commonDir)
    );
    expect(context.value.managedParentPath).toBe(expectedParent);
    expect(realpathSync(context.value.managedParentPath)).toBe(
      realpathSync(path.dirname(first.value.worktree.path))
    );
    expect(context.value.suggestedName).not.toBe('bright-fox');
    expect(context.value.suggestedName).not.toBe('quiet-otter');
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
    const ledger = createWorktreeLedger(
      () => Promise.resolve(asLedgerStore(db)),
      async () => false
    );
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
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
    });

    let hidDuplicateFromPreflight = false;
    const underlying = asLedgerStore(db);
    const staleReadDatabase: WorktreeLedgerPort = {
      async worktreeLedger(request) {
        if (!hidDuplicateFromPreflight && request.operation === 'by-path') {
          hidDuplicateFromPreflight = true;
          return { rows: [] };
        }
        return underlying.worktreeLedger(request);
      },
    };
    const service = buildService({
      getWorktreeStore: () => Promise.resolve(staleReadDatabase),
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
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(
      `worktree ${target.split(path.sep).join('/')}`
    );
    expect(git(repo, ['branch', '--list', 'bs/ledger-race']).trim()).toBe('');
  });

  it('creates successfully when another configured root no longer exists', async () => {
    const deadRoot = path.join(managedDirectory, 'disconnected-root');
    expect(existsSync(deadRoot)).toBe(false);
    const created = await buildService({
      resolveRootPaths: () =>
        Promise.resolve([
          { id: 'r-dead', path: deadRoot },
          { id: 'r-1', path: repo },
        ]),
    }).create({
      baseRef: 'main',
      branch: { name: 'bs/dead-root-tolerated' },
      createdBy: 'user',
      name: 'dead-root-tolerated',
      rootId: 'r-1',
    });

    expect(created.ok).toBe(true);
    expect(JSON.stringify(created)).not.toContain(deadRoot);
  });

  it('removes a newly created managed directory after canonical path refusal', async () => {
    const container = workspace.freshTempDir('bst-wt-canonical-refusal-');
    const canonicalRoot = path.join(container, 'canonical-root');
    const rootAlias = path.join(container, 'root-alias');
    const refusedManagedDirectory = path.join(canonicalRoot, 'managed-worktrees');
    mkdirSync(canonicalRoot);
    symlinkSync(canonicalRoot, rootAlias, 'dir');

    const created = await buildService({
      readSettings: () =>
        Promise.resolve({
          isDefaultDirectory: false,
          managedDirectory: refusedManagedDirectory,
          setupCommand: null,
        }),
      resolveRootPaths: () =>
        Promise.resolve([
          { id: 'r-1', path: repo },
          { id: 'r-alias', path: rootAlias },
        ]),
    }).create({
      baseRef: 'main',
      branch: { name: 'bs/canonical-refusal' },
      createdBy: 'user',
      name: 'canonical-refusal',
      rootId: 'r-1',
    });

    expect(created.ok).toBe(false);
    expect(created.ok === false && created.error).toContain(
      'Managed worktrees must not live inside the granted folder'
    );
    expect(existsSync(refusedManagedDirectory)).toBe(false);
  });

  it('records a thrown setup runner error without blocking worktree creation', async () => {
    const service = buildService({
      runSetup: () => Promise.reject(new Error('setup runner exploded')),
    });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/setup-throw' },
      createdBy: 'user',
      name: 'setup-throw',
      rootId: 'r-1',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.value.setup).toEqual({
      copiedPaths: [],
      output: '',
      reason: 'setup runner exploded',
      skippedCopies: [],
      status: 'failed',
      truncated: false,
    });
    expect(created.value.worktree.setupReason).toBe('setup runner exploded');
    expect(created.value.worktree.setupStatus).toBe('failed');
    const ledger = createWorktreeLedger(
      () => Promise.resolve(asLedgerStore(db)),
      async () => false
    );
    await expect(ledger.get(created.value.worktree.id)).resolves.toMatchObject({
      setupReason: 'setup runner exploded',
      setupStatus: 'failed',
    });
    const listed = await service.list();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.find((entry) => entry.id === created.value.worktree.id)).toMatchObject({
        setupReason: 'setup runner exploded',
        setupStatus: 'failed',
      });
    }
  });

  it('logs a setup-status write failure and returns the previously inserted worktree', async () => {
    const recordError = new Error('record setup write failed');
    const underlying = asLedgerStore(db);
    const recordSetupFailureDatabase: WorktreeLedgerPort = {
      async worktreeLedger(request) {
        if (request.operation === 'setup') {
          throw recordError;
        }
        return underlying.worktreeLedger(request);
      },
    };
    const created = await buildService({
      getWorktreeStore: () => Promise.resolve(recordSetupFailureDatabase),
      runSetup: () =>
        Promise.resolve({
          copiedPaths: ['package.json'],
          output: 'setup complete',
          reason: null,
          skippedCopies: [],
          status: 'succeeded' as const,
          truncated: false,
        }),
    }).create({
      baseRef: 'main',
      branch: { name: 'bs/record-setup-throw' },
      createdBy: 'user',
      name: 'record-setup-throw',
      rootId: 'r-1',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.value.setup.status).toBe('succeeded');
    expect(created.value.worktree.setupStatus).toBe('none');
    const ledger = createWorktreeLedger(
      () => Promise.resolve(underlying),
      async () => false
    );
    await expect(ledger.get(created.value.worktree.id)).resolves.toMatchObject({
      setupOutput: null,
      setupReason: null,
      setupStatus: 'none',
    });
    expect(loggerErrorSpy).toHaveBeenCalledWith('could not record worktree setup outcome', {
      error: recordError,
      setupStatus: 'succeeded',
      worktreeId: created.value.worktree.id,
    });
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

  // The mount-authorization tests (`isManagedWorktreePath`) live in
  // `worktree-mount-authorization.integration.test.ts` — extracted when the
  // BST-1392 follow-up widening pushed this file over the 1000-line ceiling.

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

  it('joins a realistic inventory with ledger provenance, labels, gates, containing root ids, and exact-mount status', async () => {
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
    const unmanagedInRootPath = path.join(managedDirectory, 'unmanaged-in-root');
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
              name: 'unmanaged-in-root',
              path: unmanagedInRootPath,
            }),
            descriptor({
              containment: 'outside-roots',
              name: 'untrusted-one',
              path: untrustedPath,
              trust: 'unvalidated',
              trustReason: null,
            }),
            // (bot review fix, PR #2664 finding 1) A worktree whose path IS
            // exactly a mounted root's own path — as opposed to the fixture
            // above, whose path only sits INSIDE `r-container`. Both produce
            // a non-null `rootId`; only this one is an exact mount.
            descriptor({
              containment: ['r-container'],
              name: 'root-container-itself',
              path: realpathSync(managedDirectory),
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
      // Contained by r-container, not an exact mount of it (bot review fix,
      // PR #2664 finding 1) — rootId keeps its existing "first containing
      // root" meaning unchanged; this is the additive, honest signal.
      rootIdIsExactMount: false,
      usable: true,
    });
    expect(
      listed.value.find((entry) => entry.path === realpathSync(managedDirectory))
    ).toMatchObject({
      rootId: 'r-container',
      rootIdIsExactMount: true,
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
    expect(listed.value.find((entry) => entry.path === unmanagedInRootPath)).toMatchObject({
      disabledReason: 'Use Worktrees → Adopt to manage this checkout.',
      managed: false,
      remedy: null,
      usable: false,
    });
    expect(listed.value.find((entry) => entry.path === untrustedPath)).toMatchObject({
      disabledReason: 'This worktree could not be verified against its own .git.',
      usable: false,
    });
  });

  it('marks the repository main worktree as the primary and refuses it as a checkout target', async () => {
    const created = await buildService().create({
      baseRef: 'main',
      branch: { name: 'bs/primary-gate' },
      createdBy: 'user',
      name: 'primary-gate',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const inventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: created.value.worktree.repoCommonDir, repositoryRoot: repo },
          worktrees: [
            {
              bare: false,
              branch: 'main',
              containment: ['r-1'],
              current: false,
              detached: false,
              head: '0123456789012345678901234567890123456789',
              lockedReason: null,
              name: 'repo',
              path: repo,
              provenance: 'scanned' as const,
              prunableReason: null,
              trust: 'validated' as const,
              trustReason: null,
            },
            {
              bare: false,
              branch: 'bs/primary-gate',
              containment: ['r-1'],
              current: false,
              detached: false,
              head: '0123456789012345678901234567890123456789',
              lockedReason: null,
              name: 'primary-gate',
              path: created.value.worktree.path,
              provenance: 'scanned' as const,
              prunableReason: null,
              trust: 'validated' as const,
              trustReason: null,
            },
          ],
        },
      ],
    } satisfies GitInventory;

    const listed = await buildService({
      resolveInventory: () => Promise.resolve(inventory),
    }).list();

    expect(listed.ok).toBe(true);
    const entries = listed.ok ? listed.value : [];
    const primary = entries.find((entry) => entry.path === repo);
    expect(primary?.primary).toBe(true);
    expect(primary?.usable).toBe(false);
    expect(primary?.disabledReason).toBe(
      "This is the repository's primary checkout — use Hand off to Local instead."
    );
    // The primary worktree has no ledger row of its own (BrainStrike did not
    // create it) — a purely scanned entry carries no creation stamp.
    expect(primary?.createdAt).toBeNull();
    expect(entries.find((entry) => entry.path === created.value.worktree.path)?.primary).toBe(
      false
    );
  });

  it('carries the repository common dir and the ledger creation stamp onto every entry', async () => {
    const commonDir = realpathSync(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    );
    const created = await buildService().create({
      baseRef: 'main',
      branch: { name: 'bs/carries-stamp' },
      createdBy: 'user',
      name: 'carries-stamp',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const ledger = createWorktreeLedger(
      () => Promise.resolve(asLedgerStore(db)),
      async () => false
    );
    await ledger.insert({
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: 'bs/ghost-stamp',
      createdAt: '2026-08-25T00:00:00.000Z',
      createdBy: 'user',
      id: '01993a12-0000-7000-8000-000000000021',
      path: '/gone',
      repoCommonDir: '/elsewhere/.git',
      runId: null,
      setupOutput: null,
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
    });
    const inventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: created.value.worktree.repoCommonDir, repositoryRoot: repo },
          worktrees: [
            {
              bare: false,
              branch: 'bs/carries-stamp',
              containment: ['r-1'],
              current: false,
              detached: false,
              head: '0123456789012345678901234567890123456789',
              lockedReason: null,
              name: 'carries-stamp',
              path: created.value.worktree.path,
              provenance: 'scanned' as const,
              prunableReason: null,
              trust: 'validated' as const,
              trustReason: null,
            },
          ],
        },
      ],
    } satisfies GitInventory;

    const listed = await buildService({
      resolveInventory: () => Promise.resolve(inventory),
    }).list();

    expect(listed.ok).toBe(true);
    const entries = listed.ok ? listed.value : [];
    const scanned = entries.find((entry) => entry.path === created.value.worktree.path);
    expect(scanned?.repoCommonDir).toBe(commonDir);
    expect(scanned?.createdAt).toBe(created.value.worktree.createdAt);
    const ghost = entries.find((entry) => entry.path === '/gone');
    // The ghost row keeps the LEDGER's own common dir — the inventory has no
    // descriptor for it, so there is nothing else that could be honest here.
    expect(ghost?.repoCommonDir).toBe('/elsewhere/.git');
    expect(ghost?.primary).toBe(false);
  });

  // `brainstrike_worktrees.path` is globally UNIQUE with no partial index
  // (migration 109) — an archived row at a path that gets recreated
  // externally must be refused, not fall through into a raw constraint
  // violation on insert. Real git + real SQLite: the archived row's path is
  // genuinely gone from disk (service.archive() ran `git worktree remove`),
  // then a real `git worktree add` recreates a DIFFERENT worktree at that
  // SAME path, so the inventory reports it again while the ledger still
  // holds the archived row.
  it('refuses to adopt an externally recreated worktree at an archived path', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/archived-path-reuse' },
      createdBy: 'user',
      name: 'archived-path-reuse',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const worktreePath = created.value.worktree.path;
    const archived = await service.archive({ worktreeId: created.value.worktree.id });
    expect(archived.ok).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);

    git(repo, ['worktree', 'add', '-b', 'bs/archived-path-reuse-external', worktreePath]);
    const commonDir = realpathSync(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    );
    const inventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: commonDir, repositoryRoot: repo },
          worktrees: [
            {
              bare: false,
              branch: 'bs/archived-path-reuse-external',
              containment: ['r-1'],
              current: false,
              detached: false,
              head: '0123456789012345678901234567890123456789',
              lockedReason: null,
              name: 'archived-path-reuse',
              path: worktreePath,
              provenance: 'scanned' as const,
              prunableReason: null,
              trust: 'validated' as const,
              trustReason: null,
            },
          ],
        },
      ],
    } satisfies GitInventory;

    const adopted = await buildService({
      resolveInventory: () => Promise.resolve(inventory),
    }).adopt({ createdBy: 'user', path: worktreePath });

    expect(adopted).toEqual({
      error: `BrainStrike archived a worktree at "${worktreePath}" — restore that one instead of adopting a new checkout at the same path.`,
      ok: false,
    });
  });

  it.each([
    ['baseRef', null],
    ['repoCommonDir', 42],
    ['createdBy', 'robot'],
    ['setupReason', 42],
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
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
      [field]: value,
    };
    const ledger = createWorktreeLedger(
      () =>
        Promise.resolve({
          worktreeLedger: () =>
            Promise.resolve({ rows: [row] } as unknown as Awaited<
              ReturnType<WorktreeLedgerPort['worktreeLedger']>
            >),
        }),
      async () => false
    );

    await expect(ledger.get(row['id'] as string)).rejects.toThrow(
      'Malformed brainstrike_worktrees row'
    );
  });
});
