import type { GitInventory, ManagedWorktreeRow, WorktreeSettings } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptWorktree,
  readCheckoutStatus,
  type WorktreeAdoptDeps,
} from '../../assistant-server/worktree-adopt';

const SETTINGS: WorktreeSettings = {
  isDefaultDirectory: true,
  managedDirectory: '/managed',
  setupCommand: null,
};

function inventory(worktrees: readonly { path: string; trust?: 'unvalidated' | 'validated' }[]) {
  return {
    errors: [],
    repositories: [
      {
        identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
        worktrees: worktrees.map((worktree) => ({
          bare: false,
          branch: 'feature',
          containment: ['root-1'] as readonly string[],
          current: false,
          detached: false,
          head: 'abc123',
          lockedReason: null,
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
});
