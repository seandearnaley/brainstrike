import type { GitWorkspaceEvent } from '@brainstrike/agent-host/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopGitWorkspace } from '../agent-host-platform/desktop-git-workspace';
import { watchGitCommonDirNatively } from '../assistant-server/git-inventory-watcher';

const { createGitInventoryServiceMock, createWorktreeServiceMock } = vi.hoisted(() => ({
  createGitInventoryServiceMock: vi.fn(),
  createWorktreeServiceMock: vi.fn(),
}));

vi.mock('../assistant-server/git-inventory-service', () => ({
  createGitInventoryService: createGitInventoryServiceMock,
}));
vi.mock('../assistant-server/worktree-service', () => ({
  createWorktreeService: createWorktreeServiceMock,
}));

function createWorkspace({ subscribe = true } = {}) {
  const gitInventoryService = {
    getSnapshot: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const worktreeService = {
    isManagedWorktreePath: vi.fn(async () => false),
    prepareClose: vi.fn(async () => undefined),
  };
  createGitInventoryServiceMock.mockReturnValue(gitInventoryService);
  createWorktreeServiceMock.mockReturnValue(worktreeService);
  const workspace = createDesktopGitWorkspace({
    homePath: '/home/tester',
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    openWorktreeFolder: vi.fn(),
    refreshWorkspaceIndex: vi.fn(async () => undefined),
    store: {} as never,
    userDataDir: '/tmp/brainstrike-git-workspace-test',
  });
  const events: GitWorkspaceEvent[] = [];
  if (subscribe) {
    workspace.service.subscribe((event) => events.push(event));
  }
  return { events, gitInventoryService, workspace, worktreeService };
}

describe('createDesktopGitWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs the ONE inventory and worktree services and starts the inventory', () => {
    const { gitInventoryService, workspace, worktreeService } = createWorkspace();

    expect(createGitInventoryServiceMock).toHaveBeenCalledTimes(1);
    expect(createWorktreeServiceMock).toHaveBeenCalledTimes(1);
    expect(gitInventoryService.start).toHaveBeenCalledTimes(1);
    // The joined `fs.watch` producer in `root-watchers.ts` lets workspace
    // close await every root watch's retirement.
    expect(createGitInventoryServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ watchDirectory: watchGitCommonDirNatively })
    );
    expect(workspace.tools.resolveWorktreeService?.()).toBe(worktreeService);
  });

  it('starts no watcher or snapshot GC before a window subscribes or reads the inventory', async () => {
    const { gitInventoryService, workspace } = createWorkspace({ subscribe: false });
    workspace.attachThreadReads({
      listThreads: () => [],
      read: async () => [],
      readLedger: () => ({ threads: [] }),
    });
    expect(gitInventoryService.start).not.toHaveBeenCalled();

    gitInventoryService.getSnapshot.mockResolvedValue({ errors: [], repositories: [] });
    const worktreeOptions = createWorktreeServiceMock.mock.calls[0]?.[0] as {
      resolveInventory: () => Promise<unknown>;
    };
    await worktreeOptions.resolveInventory();
    workspace.service.subscribe(() => undefined);

    expect(gitInventoryService.start).toHaveBeenCalledTimes(1);
    await workspace.close();
  });

  it('publishes changes-invalidated with a monotonic generation', () => {
    const { events } = createWorkspace();
    const inventoryOptions = createGitInventoryServiceMock.mock.calls[0]?.[0] as {
      onInvalidate: (event: { gitCommonDir: string; repositoryRoot: string | null }) => void;
    };

    inventoryOptions.onInvalidate({ gitCommonDir: '/repo/.git', repositoryRoot: '/repo' });
    inventoryOptions.onInvalidate({ gitCommonDir: '/repo/.git', repositoryRoot: '/repo' });

    expect(events).toEqual([
      {
        event: { generation: 1, gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
        type: 'changes-invalidated',
      },
      {
        event: { generation: 2, gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
        type: 'changes-invalidated',
      },
    ]);
  });

  it('resolves the worktree inventory through the live inventory service with a forced-fresh snapshot', async () => {
    const { gitInventoryService } = createWorkspace();
    gitInventoryService.getSnapshot.mockResolvedValue({ errors: [], repositories: ['r'] });
    const worktreeOptions = createWorktreeServiceMock.mock.calls[0]?.[0] as {
      resolveInventory: (options?: { forceFresh?: boolean }) => Promise<unknown>;
    };

    await expect(worktreeOptions.resolveInventory({ forceFresh: true })).resolves.toEqual({
      errors: [],
      repositories: ['r'],
    });
    expect(gitInventoryService.getSnapshot).toHaveBeenCalledWith({ maxAgeMs: 0 });
    await worktreeOptions.resolveInventory();
    expect(gitInventoryService.getSnapshot).toHaveBeenLastCalledWith(undefined);
  });

  it('authorizes a folder only when it is a managed worktree with a ledger row', async () => {
    const { workspace, worktreeService } = createWorkspace();
    worktreeService.isManagedWorktreePath.mockResolvedValueOnce(true);

    await expect(
      workspace.service['worktrees/classify-path'](
        { path: '/home/tester/worktrees/a' },
        new AbortController().signal
      )
    ).resolves.toEqual({ classification: 'authorized' });
  });

  it('stops publishing and retires every service once, however often it is closed', async () => {
    const { events, gitInventoryService, workspace, worktreeService } = createWorkspace();
    const inventoryOptions = createGitInventoryServiceMock.mock.calls[0]?.[0] as {
      onInvalidate: (event: { gitCommonDir: string; repositoryRoot: string | null }) => void;
    };

    await Promise.all([workspace.close(), workspace.close()]);
    inventoryOptions.onInvalidate({ gitCommonDir: '/repo/.git', repositoryRoot: '/repo' });

    expect(events).toEqual([]);
    expect(worktreeService.prepareClose).toHaveBeenCalledTimes(1);
    expect(gitInventoryService.stop).toHaveBeenCalledTimes(1);
  });
});
