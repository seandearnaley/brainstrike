import { describe, expect, it, vi } from 'vitest';
import type { WorktreeService } from '../../src/git-workspace/worktree-service.ts';
import {
  type HostWorktreeServices,
  hostWorktreeToolDependencies,
} from '../../src/git-workspace/worktree-tool-dependencies.ts';

type OpenWorktreeFolder = NonNullable<HostWorktreeServices['openWorktreeFolder']>;

const created = {
  ok: true as const,
  value: {
    setup: { reason: null, status: 'none' },
    worktree: { branch: 'bs/fox', id: 'wt-9', path: '/managed/fox' },
  },
};
const params = { baseRef: 'HEAD', branch: 'bs/fox', name: 'fox', rootId: 'root-1' };
const root = { displayName: 'fox', path: '/managed/fox', rootId: 'wt-root' };

function services(
  create: () => Promise<unknown>,
  openWorktreeFolder: OpenWorktreeFolder
): HostWorktreeServices {
  const service = { archive: vi.fn(), create, list: vi.fn() } as unknown as WorktreeService;
  return { openWorktreeFolder, resolveWorktreeService: () => service };
}

describe("Main's agent worktree create (ADR-0028 step 3)", () => {
  it('opens the worktree an agent created as a folder and returns that folder', async () => {
    const openWorktreeFolder = vi.fn<OpenWorktreeFolder>().mockResolvedValue(root);
    const { worktreeTools } = hostWorktreeToolDependencies(
      services(vi.fn().mockResolvedValue(created), openWorktreeFolder),
      { runId: 'run-1', threadId: 'thread-1' }
    );

    await expect(worktreeTools?.create(params)).resolves.toEqual({
      ok: true,
      value: { ...created.value, root },
    });
    expect(openWorktreeFolder).toHaveBeenCalledExactlyOnceWith('/managed/fox');
  });

  it('opens nothing when the worktree service refused', async () => {
    const openWorktreeFolder = vi.fn<OpenWorktreeFolder>();
    const { worktreeTools } = hostWorktreeToolDependencies(
      services(
        vi.fn().mockResolvedValue({ error: 'branch exists', ok: false }),
        openWorktreeFolder
      ),
      { runId: 'run-1', threadId: 'thread-1' }
    );

    await expect(worktreeTools?.create(params)).resolves.toEqual({
      error: 'branch exists',
      ok: false,
    });
    expect(openWorktreeFolder).not.toHaveBeenCalled();
  });
});
