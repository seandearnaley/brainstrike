import { describe, expect, it, vi } from 'vitest';
import {
  runManageWorktree,
  type WorktreeToolCapability,
} from '../../assistant-server/worktree-tools';

const runtime = {
  workspaceRoots: [{ displayName: 'brainstrike', path: '/repo', rootId: 'root-1' }],
} as never;

describe('host-owned worktree tool outcomes', () => {
  it('retains setup refusal and exact created worktree in the committed tool result', async () => {
    const capability: WorktreeToolCapability = {
      archive: vi.fn(),
      create: vi.fn(async () => ({
        ok: true as const,
        value: {
          setup: { reason: 'Setup command exited with code 3.', status: 'failed' },
          worktree: { branch: 'bs/example', id: 'w-1', path: '/repo/wt' },
        },
      })),
      list: vi.fn(),
    };
    await expect(
      runManageWorktree({ action: 'create', branch: 'bs/example' }, runtime, capability)
    ).resolves.toEqual({
      action: 'create',
      branch: 'bs/example',
      path: '/repo/wt',
      setupReason: 'Setup command exited with code 3.',
      setupStatus: 'failed',
      worktreeId: 'w-1',
    });
    expect(capability.create).toHaveBeenCalledExactlyOnceWith({
      baseRef: 'HEAD',
      branch: 'bs/example',
      name: 'example',
      rootId: 'root-1',
    });
  });

  it('retains the actual archive snapshot and propagates service refusal', async () => {
    const archive = vi
      .fn<WorktreeToolCapability['archive']>()
      .mockResolvedValueOnce({
        ok: true,
        value: { snapshotRef: 'refs/brainstrike/worktree-archive/w-1', worktree: { id: 'w-1' } },
      })
      .mockResolvedValueOnce({ error: 'running thread owns worktree', ok: false });
    const capability = { archive, create: vi.fn(), list: vi.fn() };
    const input = { action: 'archive' as const, worktreeId: 'w-1' };
    await expect(runManageWorktree(input, runtime, capability)).resolves.toEqual({
      action: 'archive',
      snapshotRef: 'refs/brainstrike/worktree-archive/w-1',
      worktreeId: 'w-1',
    });
    await expect(runManageWorktree(input, runtime, capability)).rejects.toThrow(
      'running thread owns worktree'
    );
    expect(archive).toHaveBeenCalledTimes(2);
  });
});
