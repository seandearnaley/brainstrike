import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createForgeServiceMock, createGitInventoryServiceMock, createWorktreeServiceMock } =
  vi.hoisted(() => ({
    createForgeServiceMock: vi.fn(),
    createGitInventoryServiceMock: vi.fn(),
    createWorktreeServiceMock: vi.fn(),
  }));

vi.mock('../../assistant-server/forge-service', () => ({
  createForgeService: createForgeServiceMock,
}));
vi.mock('../../assistant-server/git-inventory-service', () => ({
  createGitInventoryService: createGitInventoryServiceMock,
}));
vi.mock('../../assistant-server/worktree-service', () => ({
  createWorktreeService: createWorktreeServiceMock,
}));
vi.mock('../../ipc-forge', () => ({
  registerForgeIpcHandlers: vi.fn(() => vi.fn()),
}));
vi.mock('@brainstrike/file-system/electron', () => {
  const MockAdapter = vi.fn();
  MockAdapter.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, { watchDirectory: vi.fn(() => vi.fn()) });
  });
  return { ElectronFileSystemAdapter: MockAdapter };
});

import { startGitAwarenessLifecycle } from '../../main/git-awareness-lifecycle';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

function createDeps() {
  const forgeService = {
    onRepositoryInvalidated: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const gitInventoryService = { getSnapshot: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const worktreeService = { isManagedWorktreePath: vi.fn() };
  createForgeServiceMock.mockReturnValue(forgeService);
  createGitInventoryServiceMock.mockReturnValue(gitInventoryService);
  createWorktreeServiceMock.mockReturnValue(worktreeService);
  const broadcast = vi.fn<(channel: string, payload: unknown) => void>();
  return {
    broadcast,
    deps: {
      broadcast,
      hasRunningThread: vi.fn(async () => false),
      homePath: '/home/tester',
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
      storage: {} as never,
      workspaceRoots: {
        forgeCache: vi.fn(async () => ({ entry: null })),
        forgeCacheSnapshot: async () => [],
        workspaceRoots: vi.fn(async () => ({ roots: [] })),
        worktreeLedger: vi.fn(async () => ({ rows: [] })),
      },
    },
    forgeService,
    gitInventoryService,
    worktreeService,
  };
}

describe('startGitAwarenessLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs the ONE inventory, forge, and worktree services, starts the inventory, and returns them', () => {
    const { deps, forgeService, gitInventoryService, worktreeService } = createDeps();

    const lifecycle = startGitAwarenessLifecycle(deps);

    expect(createForgeServiceMock).toHaveBeenCalledTimes(1);
    expect(createGitInventoryServiceMock).toHaveBeenCalledTimes(1);
    expect(createWorktreeServiceMock).toHaveBeenCalledTimes(1);
    expect(gitInventoryService.start).toHaveBeenCalledTimes(1);
    expect(lifecycle.forgeService).toBe(forgeService);
    expect(lifecycle.gitInventoryService).toBe(gitInventoryService);
    expect(lifecycle.worktreeService).toBe(worktreeService);
    expect(typeof lifecycle.unregisterForgeIpc).toBe('function');
  });

  it('broadcasts changes:invalidated with a monotonic generation and fans the signal out to forge', () => {
    const { broadcast, deps, forgeService } = createDeps();
    startGitAwarenessLifecycle(deps);
    const inventoryOptions = createGitInventoryServiceMock.mock.calls[0]?.[0] as {
      onInvalidate: (event: { gitCommonDir: string; repositoryRoot: string | null }) => void;
    };

    inventoryOptions.onInvalidate({ gitCommonDir: '/repo/.git', repositoryRoot: '/repo' });
    inventoryOptions.onInvalidate({ gitCommonDir: '/repo/.git', repositoryRoot: '/repo' });

    expect(broadcast.mock.calls).toEqual([
      [
        DESKTOP_IPC_CHANNELS.changes.invalidated,
        { generation: 1, gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
      ],
      [
        DESKTOP_IPC_CHANNELS.changes.invalidated,
        { generation: 2, gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
      ],
    ]);
    expect(forgeService.onRepositoryInvalidated).toHaveBeenCalledWith('/repo/.git');
    expect(forgeService.onRepositoryInvalidated).toHaveBeenCalledTimes(2);
  });

  it('broadcasts forge:prUpdated with its own monotonic generation', () => {
    const { broadcast, deps } = createDeps();
    startGitAwarenessLifecycle(deps);
    const forgeOptions = createForgeServiceMock.mock.calls[0]?.[0] as {
      onPrUpdated: (event: { rootId: string }) => void;
    };

    forgeOptions.onPrUpdated({ rootId: 'root-1' });
    forgeOptions.onPrUpdated({ rootId: 'root-1' });

    expect(broadcast.mock.calls).toEqual([
      [DESKTOP_IPC_CHANNELS.forge.prUpdated, { generation: 1, rootId: 'root-1' }],
      [DESKTOP_IPC_CHANNELS.forge.prUpdated, { generation: 2, rootId: 'root-1' }],
    ]);
  });

  it('resolves the worktree inventory through the live inventory service with a forced-fresh snapshot', async () => {
    const { deps, gitInventoryService } = createDeps();
    gitInventoryService.getSnapshot.mockResolvedValue({ errors: [], repositories: ['r'] });
    startGitAwarenessLifecycle(deps);
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
});
