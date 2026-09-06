import { describe, expect, it, vi } from 'vitest';
import { runListWorktrees, runManageWorktree } from '../../assistant-server/worktree-tools';

const RUNTIME = {
  workspaceRoots: [{ displayName: 'brainstrike', path: '/repo', rootId: 'root-1' }],
} as never;

function capability(overrides: Record<string, unknown> = {}) {
  return {
    archive: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    ...overrides,
  };
}

describe('runListWorktrees', () => {
  it('projects the ledger-joined listing, keeping unusable rows with their reasons', async () => {
    const caps = capability({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            branch: 'main',
            detached: false,
            disabledReason: null,
            externalTool: null,
            id: null,
            managed: false,
            name: 'repo',
            path: '/repo',
            primary: true,
            provenance: 'scanned',
            repositoryRoot: '/repo',
            usable: false,
          },
          {
            branch: 'bs/fox',
            detached: false,
            disabledReason: 'Locked: rebase in progress',
            externalTool: 'claude-code',
            id: 'wt-1',
            managed: true,
            name: 'fox',
            path: '/wt',
            primary: false,
            provenance: 'both',
            repositoryRoot: '/repo',
            usable: false,
          },
        ],
      }),
    });

    const result = await runListWorktrees({}, RUNTIME, caps as never);

    expect(caps.list).toHaveBeenCalledTimes(1);
    expect(caps.create).not.toHaveBeenCalled();
    expect(caps.archive).not.toHaveBeenCalled();
    expect(result.worktrees).toHaveLength(2);
    expect(result.worktrees[1]).toEqual({
      branch: 'bs/fox',
      detached: false,
      disabledReason: 'Locked: rebase in progress',
      externalTool: 'claude-code',
      managed: true,
      name: 'fox',
      path: '/wt',
      primary: false,
      provenance: 'both',
      repositoryRoot: '/repo',
      usable: false,
      worktreeId: 'wt-1',
    });
  });

  it('scopes by repository identity (repoCommonDir), not path equality, when `root` is the primary checkout', async () => {
    const caps = capability({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            branch: null,
            disabledReason: null,
            id: null,
            name: 'a',
            path: '/repo',
            primary: true,
            repoCommonDir: '/repo/.git',
            repositoryRoot: '/repo',
            rootId: 'root-1',
            usable: true,
          },
          {
            branch: null,
            disabledReason: null,
            id: 'b',
            name: 'b',
            path: '/other',
            primary: false,
            repoCommonDir: '/other/.git',
            repositoryRoot: '/other',
            rootId: null,
            usable: true,
          },
        ],
      }),
    });

    const result = await runListWorktrees({ root: 'brainstrike' }, RUNTIME, caps as never);

    expect(result.worktrees.map((worktree) => worktree.name)).toEqual(['a']);
  });

  it('returns every sibling worktree of the repository, including the primary, when `root` is a worktree-mounted root (the W5 scenario)', async () => {
    // The bot review this pins (PR #2666): a thread bound to a WORKTREE
    // checkout, not the primary. `root.path` is the worktree's own path;
    // `entry.repositoryRoot` for every row is the PRIMARY checkout's path
    // (never equal to root.path), and `rootId` is null on every entry except
    // the one that IS the granted root — assertWorktreeTargetOutsideRoots
    // keeps every OTHER managed worktree, and the primary, outside every
    // granted root by policy. The old `repositoryRoot === root.path ||
    // rootId === root.rootId` filter returned exactly one row here (the
    // worktree itself); repoCommonDir scoping must return all three.
    const worktreeRuntime = {
      workspaceRoots: [{ displayName: 'fox', path: '/managed/fox', rootId: 'root-fox' }],
    } as never;
    const caps = capability({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            branch: 'main',
            disabledReason: null,
            id: null,
            name: 'repo',
            path: '/repo',
            primary: true,
            repoCommonDir: '/repo/.git',
            repositoryRoot: '/repo',
            rootId: null,
            usable: true,
          },
          {
            branch: 'bs/fox',
            disabledReason: null,
            id: 'wt-fox',
            name: 'fox',
            path: '/managed/fox',
            primary: false,
            repoCommonDir: '/repo/.git',
            repositoryRoot: '/repo',
            rootId: 'root-fox',
            usable: true,
          },
          {
            branch: 'bs/badger',
            disabledReason: null,
            id: 'wt-badger',
            name: 'badger',
            path: '/managed/badger',
            primary: false,
            repoCommonDir: '/repo/.git',
            repositoryRoot: '/repo',
            rootId: null,
            usable: true,
          },
          {
            branch: null,
            disabledReason: null,
            id: null,
            name: 'unrelated',
            path: '/other',
            primary: true,
            repoCommonDir: '/other/.git',
            repositoryRoot: '/other',
            rootId: null,
            usable: true,
          },
        ],
      }),
    });

    const result = await runListWorktrees({ root: 'fox' }, worktreeRuntime, caps as never);

    expect(result.worktrees.map((worktree) => worktree.name).sort()).toEqual([
      'badger',
      'fox',
      'repo',
    ]);
  });

  it('throws a stated error naming the root when no entry identifies it, rather than returning an empty list', async () => {
    const caps = capability({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            branch: null,
            disabledReason: null,
            id: null,
            name: 'a',
            path: '/elsewhere',
            primary: true,
            repoCommonDir: '/elsewhere/.git',
            repositoryRoot: '/elsewhere',
            rootId: null,
            usable: true,
          },
        ],
      }),
    });

    await expect(runListWorktrees({ root: 'brainstrike' }, RUNTIME, caps as never)).rejects.toThrow(
      'Could not resolve workspace root "brainstrike" to a worktree entry.'
    );
  });

  it('throws a stated error when the capability is absent — never an empty list', async () => {
    await expect(runListWorktrees({}, RUNTIME, undefined)).rejects.toThrow(
      'Worktree management is not available in this session.'
    );
  });

  it('throws the service refusal verbatim', async () => {
    const caps = capability({
      list: vi.fn().mockResolvedValue({ error: 'inventory failed', ok: false }),
    });

    await expect(runListWorktrees({}, RUNTIME, caps as never)).rejects.toThrow('inventory failed');
  });
});

describe('runManageWorktree', () => {
  it('creates through the capability, defaulting baseRef to HEAD and name to the branch leaf', async () => {
    const caps = capability({
      create: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          setup: { reason: null, status: 'none' },
          worktree: { branch: 'bs/fox', id: 'wt-9', path: '/managed/fox' },
        },
      }),
    });

    const result = await runManageWorktree(
      { action: 'create', branch: 'bs/fox' },
      RUNTIME,
      caps as never
    );

    expect(caps.create).toHaveBeenCalledTimes(1);
    expect(caps.create).toHaveBeenCalledWith({
      baseRef: 'HEAD',
      branch: 'bs/fox',
      name: 'fox',
      rootId: 'root-1',
    });
    expect(caps.archive).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'create',
      branch: 'bs/fox',
      path: '/managed/fox',
      setupReason: null,
      setupStatus: 'none',
      worktreeId: 'wt-9',
    });
  });

  it('archives through the capability and reports the snapshot ref', async () => {
    const caps = capability({
      archive: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          snapshotRef: 'refs/brainstrike/worktree-archive/wt-9',
          worktree: { id: 'wt-9', path: '/managed/fox' },
        },
      }),
    });

    const result = await runManageWorktree(
      { action: 'archive', worktreeId: 'wt-9' },
      RUNTIME,
      caps as never
    );

    expect(caps.archive).toHaveBeenCalledTimes(1);
    expect(caps.archive).toHaveBeenCalledWith({ worktreeId: 'wt-9' });
    expect(caps.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'archive',
      snapshotRef: 'refs/brainstrike/worktree-archive/wt-9',
      worktreeId: 'wt-9',
    });
  });

  it('forwards force only when the model asked for it', async () => {
    const caps = capability({
      archive: vi.fn().mockResolvedValue({
        ok: true,
        value: { snapshotRef: 'ref', worktree: { id: 'wt-9', path: '/x' } },
      }),
    });

    await runManageWorktree(
      { action: 'archive', force: true, worktreeId: 'wt-9' },
      RUNTIME,
      caps as never
    );

    expect(caps.archive).toHaveBeenCalledWith({ force: true, worktreeId: 'wt-9' });
  });

  it('throws an archive refusal verbatim so the model sees the blocker', async () => {
    const caps = capability({
      archive: vi.fn().mockResolvedValue({ error: 'A run is active in this worktree.', ok: false }),
    });

    await expect(
      runManageWorktree({ action: 'archive', worktreeId: 'wt-9' }, RUNTIME, caps as never)
    ).rejects.toThrow('A run is active in this worktree.');
  });
});
