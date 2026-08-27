import type { GitInventory, ManagedWorktreeRow, WorktreeSettings } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptWorktree,
  readCheckoutStatus,
  reconcileWorktreesFromShell,
  type WorktreeAdoptDeps,
} from '../../assistant-server/worktree-adopt';

const SETTINGS: WorktreeSettings = {
  isDefaultDirectory: true,
  managedDirectory: '/managed',
  setupCommand: null,
};

function inventory(
  worktrees: readonly {
    path: string;
    branch?: string | null;
    lockedReason?: string | null;
    trust?: 'unvalidated' | 'validated';
  }[]
) {
  return {
    errors: [],
    repositories: [
      {
        identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
        worktrees: worktrees.map((worktree) => ({
          bare: false,
          branch: worktree.branch === undefined ? 'feature' : worktree.branch,
          containment: ['root-1'] as readonly string[],
          current: false,
          detached: false,
          head: 'abc123',
          lockedReason: worktree.lockedReason ?? null,
          name: worktree.path.split('/').at(-1) ?? '',
          path: worktree.path,
          provenance: 'scanned' as const,
          prunableReason: null,
          trust: worktree.trust ?? ('validated' as const),
          trustReason: null,
        })),
      },
    ],
  } satisfies GitInventory;
}

function makeDeps(overrides: {
  readonly getByPath?: (path: string) => Promise<ManagedWorktreeRow | null>;
  readonly inventoryValue?: GitInventory;
  readonly rootPaths?: readonly { readonly id: string; readonly path: string }[];
}) {
  const insert = vi.fn(async (row: ManagedWorktreeRow) => row);
  const getByPath = vi.fn(overrides.getByPath ?? (() => Promise.resolve(null)));
  const run = vi.fn<WorktreeAdoptDeps['run']>(async () => ({
    exitCode: 0,
    stderr: '',
    stdout: 'deadbeef\n',
    timedOut: false,
  }));
  return {
    deps: {
      ledger: { getByPath, insert } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () =>
        Promise.resolve(overrides.inventoryValue ?? inventory([{ path: '/repo/wt' }])),
      resolveRootPaths: () =>
        Promise.resolve(overrides.rootPaths ?? [{ id: 'root-1', path: '/repo' }]),
      run,
    },
    getByPath,
    insert,
    run,
  };
}

describe('adoptWorktree', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts a ledger row for an in-root scanned worktree, recording HEAD as the base ref', async () => {
    const { deps, insert, run } = makeDeps({});

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result.ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0]?.[0];
    expect(row?.baseRef).toBe('deadbeef');
    expect(row?.branch).toBe('feature');
    expect(row?.createdBy).toBe('user');
    expect(row?.path).toBe('/repo/wt');
    expect(row?.repoCommonDir).toBe('/repo/.git');
    expect(row?.setupStatus).toBe('none');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refuses a worktree the inventory does not know', async () => {
    const { deps, insert } = makeDeps({});

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/elsewhere/wt' });

    expect(result).toEqual({
      error:
        'No worktree at "/elsewhere/wt" is visible in the workspace inventory, so it cannot be adopted.',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses an unvalidated worktree', async () => {
    const { deps, insert } = makeDeps({
      inventoryValue: inventory([{ path: '/repo/wt', trust: 'unvalidated' }]),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('could not be verified');
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a worktree outside every root and outside the managed directory', async () => {
    const { deps, insert } = makeDeps({
      inventoryValue: {
        errors: [],
        repositories: [
          {
            identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
            worktrees: [
              {
                bare: false,
                branch: 'feature',
                containment: 'outside-roots',
                current: false,
                detached: false,
                head: 'abc123',
                lockedReason: null,
                name: 'wt',
                path: '/tmp/wt',
                provenance: 'scanned',
                prunableReason: null,
                trust: 'validated',
                trustReason: null,
              },
            ],
          },
        ],
      },
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/tmp/wt' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Grant access to its folder first');
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a path that already has a live ledger row', async () => {
    const { deps, insert } = makeDeps({
      getByPath: () =>
        Promise.resolve({
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'main',
          branch: 'feature',
          createdAt: '2026-08-26T00:00:00.000Z',
          createdBy: 'user',
          id: 'existing',
          path: '/repo/wt',
          repoCommonDir: '/repo/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: null,
        }),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result).toEqual({
      error: 'BrainStrike already manages the worktree at "/repo/wt".',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  // `brainstrike_worktrees.path` is globally UNIQUE with no partial index, so
  // an archived row at the same path (worktree archived, then recreated
  // externally at the identical path) would hit that constraint on insert if
  // this fell through — a raw Postgres error reaching the user instead of a
  // stated refusal. The unit mock's `insert` is `async (row) => row`, so it
  // can never surface the constraint itself; this only pins the REFUSAL.
  it('refuses a path that has an archived ledger row, naming restore as the remedy', async () => {
    const { deps, insert } = makeDeps({
      getByPath: () =>
        Promise.resolve({
          archivedAt: '2026-08-20T00:00:00.000Z',
          archiveSnapshotRef: 'refs/brainstrike/worktree-archive/existing',
          baseRef: 'main',
          branch: 'feature',
          createdAt: '2026-08-01T00:00:00.000Z',
          createdBy: 'user',
          id: 'existing',
          path: '/repo/wt',
          repoCommonDir: '/repo/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: null,
        }),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result).toEqual({
      error:
        'BrainStrike archived a worktree at "/repo/wt" — restore that one instead of adopting a new checkout at the same path.',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a locked worktree, naming the lock reason and the unlock remedy', async () => {
    const { deps, insert, run } = makeDeps({
      inventoryValue: inventory([{ lockedReason: 'maintenance', path: '/repo/wt' }]),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result).toEqual({
      error:
        'The worktree at "/repo/wt" is locked (maintenance) and cannot be adopted — unlock it (`git worktree unlock`) first.',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to adopt the repository's own primary checkout", async () => {
    const { deps, insert } = makeDeps({
      inventoryValue: inventory([{ path: '/repo' }]),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo' });

    expect(result).toEqual({
      error:
        'The worktree at "/repo" is the repository\'s primary checkout — use Hand off to Local instead.',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("reads the inventory WITHOUT forcing freshness (unlike reconcileWorktreesFromShell's post-command read — this is a user-driven click, not a race against a command that just ran)", async () => {
    const resolveInventory = vi.fn(() => Promise.resolve(inventory([{ path: '/repo/wt' }])));
    const deps = {
      ledger: { getByPath: vi.fn(async () => null), insert: vi.fn(async (row) => row) } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory,
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'deadbeef\n', timedOut: false })),
    };

    await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(resolveInventory).toHaveBeenCalledWith();
  });
});

describe('readCheckoutStatus', () => {
  it('parses ahead/behind and cleanliness from one porcelain-v2 read', async () => {
    const { deps, run } = makeDeps({});
    run
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '', timedOut: false })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout: [
          '# branch.head feature',
          '# branch.upstream origin/feature',
          '# branch.ab +2 -1',
          '',
        ].join('\0'),
        timedOut: false,
      });

    const result = await readCheckoutStatus(deps, { path: '/repo/wt' });

    expect(result).toEqual({
      ok: true,
      value: {
        ahead: 2,
        behind: 1,
        clean: true,
        path: '/repo/wt',
        upstream: 'origin/feature',
      },
    });
    expect(run).toHaveBeenCalledTimes(2);
    const statusCall = run.mock.calls[1]?.[0];
    expect(statusCall).toMatchObject({ cwd: '/repo/wt' });
    expect(statusCall?.args.slice(-4)).toEqual(['status', '--porcelain=v2', '--branch', '-z']);
  });

  it('refuses a path the inventory does not report', async () => {
    const { deps, run } = makeDeps({});

    const result = await readCheckoutStatus(deps, { path: '/etc' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('not visible in the workspace inventory');
    expect(run).not.toHaveBeenCalled();
  });

  // The inventory deliberately keeps a fabricated/unvalidated descriptor
  // visible (so the user can SEE that something claims to live there), but
  // `locate` finding one is not proof it is safe to run git in it — a
  // descriptor could point at an entirely different real repository. Mirrors
  // `adoptWorktree`'s own `trust === 'unvalidated'` refusal.
  it('refuses an unvalidated worktree before running any git', async () => {
    const { deps, run } = makeDeps({
      inventoryValue: inventory([{ path: '/repo/wt', trust: 'unvalidated' }]),
    });

    const result = await readCheckoutStatus(deps, { path: '/repo/wt' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('could not be verified');
    expect(run).not.toHaveBeenCalled();
  });

  // NO-SILENT-FALLBACKS: a failed `git status` read STATES itself and must
  // never coerce to a default "clean" value — a status the caller never
  // actually read is not the same fact as a checkout with nothing to commit.
  it('states a failed git status instead of coercing it to clean', async () => {
    const { deps, run } = makeDeps({});
    run
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '', timedOut: false })
      .mockResolvedValueOnce({
        exitCode: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
        stdout: '',
        timedOut: false,
      });

    const result = await readCheckoutStatus(deps, { path: '/repo/wt' });

    expect(result).toEqual({
      error: 'fatal: not a git repository (or any of the parent directories): .git',
      ok: false,
    });
  });
});

describe('reconcileWorktreesFromShell', () => {
  it('adopts every on-disk worktree of the repository that has no live ledger row', async () => {
    const inserted: ManagedWorktreeRow[] = [];
    const deps = {
      ledger: {
        getByPath: vi.fn(async (target: string) =>
          target === '/repo/known'
            ? ({ archivedAt: null, id: 'known-1', path: '/repo/known' } as never)
            : null
        ),
        insert: vi.fn(async (row: ManagedWorktreeRow) => {
          inserted.push(row);
          return row;
        }),
        listActive: vi.fn(async () => [
          { id: 'known-1', path: '/repo/known', repoCommonDir: '/repo/.git' } as never,
          { id: 'gone-1', path: '/repo/gone', repoCommonDir: '/repo/.git' } as never,
        ]),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () =>
        Promise.resolve(
          inventory([{ path: '/repo' }, { path: '/repo/known' }, { path: '/repo/new' }])
        ),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: 'deadbeef\n',
        timedOut: false,
      })),
    };

    const result = await reconcileWorktreesFromShell(deps, {
      precedingWorktreePaths: new Set(['/repo', '/repo/known']),
      repoCommonDir: '/repo/.git',
      runId: 'run-1',
      threadId: 'thread-1',
    });

    expect(result.ok).toBe(true);
    // Only the NEW linked worktree is adopted: the primary checkout is not a
    // managed worktree, and the known one already has a row.
    expect(inserted.map((row) => row.path)).toEqual(['/repo/new']);
    expect(inserted[0]?.createdBy).toBe('agent');
    expect(inserted[0]?.runId).toBe('run-1');
    expect(inserted[0]?.threadId).toBe('thread-1');
    expect(result.ok && result.value.adopted).toHaveLength(1);
  });

  it('reports ledger rows that vanished from disk without archiving or deleting them', async () => {
    const insert = vi.fn();
    const deps = {
      ledger: {
        getByPath: vi.fn(async () => null),
        insert,
        listActive: vi.fn(async () => [
          { id: 'gone-1', path: '/repo/gone', repoCommonDir: '/repo/.git' } as never,
        ]),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () => Promise.resolve(inventory([{ path: '/repo' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(),
    };

    const result = await reconcileWorktreesFromShell(deps, {
      precedingWorktreePaths: new Set(),
      repoCommonDir: '/repo/.git',
    });

    expect(result.ok && result.value.vanishedLedgerIds).toEqual(['gone-1']);
    // A `git worktree remove` in a shell is NOT an archive: there is no
    // snapshot, so pretending it was one would make `restore` promise
    // something it cannot deliver. The ghost row is the honest surface.
    expect(insert).not.toHaveBeenCalled();
  });

  it('does not adopt a pre-existing unmanaged worktree, even though it has no ledger row', async () => {
    const inserted: ManagedWorktreeRow[] = [];
    const deps = {
      ledger: {
        getByPath: vi.fn(async () => null),
        insert: vi.fn(async (row: ManagedWorktreeRow) => {
          inserted.push(row);
          return row;
        }),
        listActive: vi.fn(async () => []),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () =>
        Promise.resolve(inventory([{ path: '/repo' }, { path: '/repo/external' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: 'deadbeef\n',
        timedOut: false,
      })),
    };

    const result = await reconcileWorktreesFromShell(deps, {
      precedingWorktreePaths: new Set(['/repo', '/repo/external']),
      repoCommonDir: '/repo/.git',
      runId: 'run-1',
    });

    expect(result.ok).toBe(true);
    expect(inserted).toHaveLength(0);
    expect(result.ok && result.value.adopted).toHaveLength(0);
  });

  it('adopts a worktree that appeared after the pre-command snapshot, attributed to this run', async () => {
    const inserted: ManagedWorktreeRow[] = [];
    const deps = {
      ledger: {
        getByPath: vi.fn(async () => null),
        insert: vi.fn(async (row: ManagedWorktreeRow) => {
          inserted.push(row);
          return row;
        }),
        listActive: vi.fn(async () => []),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () =>
        Promise.resolve(inventory([{ path: '/repo' }, { path: '/repo/just-created' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: 'deadbeef\n',
        timedOut: false,
      })),
    };

    const result = await reconcileWorktreesFromShell(deps, {
      precedingWorktreePaths: new Set(['/repo']),
      repoCommonDir: '/repo/.git',
      runId: 'run-1',
      threadId: 'thread-1',
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.path).toBe('/repo/just-created');
    expect(inserted[0]?.createdBy).toBe('agent');
    expect(inserted[0]?.runId).toBe('run-1');
    expect(inserted[0]?.threadId).toBe('thread-1');
    expect(result.ok && result.value.adopted).toHaveLength(1);
  });

  it('adopts nothing and logs, rather than adopting everything, when no pre-command snapshot is available', async () => {
    const insert = vi.fn();
    const deps = {
      ledger: {
        getByPath: vi.fn(async () => null),
        insert,
        listActive: vi.fn(async () => []),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () =>
        Promise.resolve(inventory([{ path: '/repo' }, { path: '/repo/mystery' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(),
    };

    const result = await reconcileWorktreesFromShell(deps, {
      precedingWorktreePaths: undefined,
      repoCommonDir: '/repo/.git',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.adopted).toHaveLength(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it('does not adopt a `git worktree move` destination as a new row, and states it as a likely move', async () => {
    // Composite delta (BST-1392 review, P1): one command both moves an
    // existing managed worktree (`/repo/old` -> `/repo/old-moved`, same
    // branch) AND creates a genuinely new, unrelated one (`/repo/brand-new`).
    // The move must not be adopted as new (that would fabricate a "created"
    // event and orphan the original row's identity/thread/lineage), while the
    // unrelated new worktree must still be adopted normally.
    const inserted: ManagedWorktreeRow[] = [];
    const deps = {
      ledger: {
        getByPath: vi.fn(async () => null),
        insert: vi.fn(async (row: ManagedWorktreeRow) => {
          inserted.push(row);
          return row;
        }),
        listActive: vi.fn(async () => [
          {
            branch: 'bs/feature',
            id: 'moved-1',
            path: '/repo/old',
            repoCommonDir: '/repo/.git',
          } as never,
        ]),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () =>
        Promise.resolve(
          inventory([
            { path: '/repo' },
            { branch: 'bs/feature', path: '/repo/old-moved' },
            { branch: 'bs/other', path: '/repo/brand-new' },
          ])
        ),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: 'deadbeef\n',
        timedOut: false,
      })),
    };

    const result = await reconcileWorktreesFromShell(deps, {
      precedingWorktreePaths: new Set(['/repo', '/repo/old']),
      repoCommonDir: '/repo/.git',
      runId: 'run-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // No duplicate adoption of the moved worktree: only the unrelated new one
    // is inserted/adopted.
    expect(inserted.map((row) => row.path)).toEqual(['/repo/brand-new']);
    expect(result.value.adopted).toHaveLength(1);
    expect(result.value.adopted[0]?.path).toBe('/repo/brand-new');
    // No false "created" event for the move: it never reaches `adopted`.
    expect(inserted.some((row) => row.path === '/repo/old-moved')).toBe(false);
    // The likely-move is stated, not silently dropped.
    expect(result.value.likelyMoves).toEqual([
      {
        branch: 'bs/feature',
        newPath: '/repo/old-moved',
        vanishedLedgerId: 'moved-1',
        vanishedPath: '/repo/old',
      },
    ]);
    // Ledger identity is not rewritten: the original row still surfaces as a
    // vanished ghost, exactly as an actual `git worktree remove` would.
    expect(result.value.vanishedLedgerIds).toEqual(['moved-1']);
  });

  it('requests a forced-fresh inventory read (BST-1392 W5 e2e: a cached post-command read reliably misses a worktree the shell command just created)', async () => {
    const resolveInventory = vi.fn(() => Promise.resolve(inventory([{ path: '/repo' }])));
    const deps = {
      ledger: {
        getByPath: vi.fn(async () => null),
        insert: vi.fn(async (row: ManagedWorktreeRow) => row),
        listActive: vi.fn(async () => []),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory,
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(),
    };

    await reconcileWorktreesFromShell(deps, {
      precedingWorktreePaths: new Set(['/repo']),
      repoCommonDir: '/repo/.git',
    });

    expect(resolveInventory).toHaveBeenCalledWith({ forceFresh: true });
  });
});
