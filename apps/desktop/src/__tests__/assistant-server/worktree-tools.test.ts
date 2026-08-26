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

  it('scopes to one root when `root` is supplied', async () => {
    const caps = capability({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            branch: null,
            disabledReason: null,
            id: 'a',
            name: 'a',
            path: '/a',
            primary: false,
            repositoryRoot: '/repo',
            usable: true,
          },
          {
            branch: null,
            disabledReason: null,
            id: 'b',
            name: 'b',
            path: '/b',
            primary: false,
            repositoryRoot: '/other',
            usable: true,
          },
        ],
      }),
    });

    const result = await runListWorktrees({ root: 'brainstrike' }, RUNTIME, caps as never);

    expect(result.worktrees.map((worktree) => worktree.name)).toEqual(['a']);
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
