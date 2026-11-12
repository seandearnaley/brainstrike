import type { HostIdleWorktreeArchive } from '@brainstrike/agent-host';
import type { GitWorkspaceEvent } from '@brainstrike/agent-host/protocol';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { watchGitCommonDirNatively } from '../../src/git-workspace/git-inventory-watcher.ts';
import { createGitWorkspace } from '../../src/git-workspace/host-git-workspace.ts';
import type {
  WorktreeArchiveParams,
  WorktreeServiceDeps,
} from '../../src/git-workspace/worktree-service-inputs.ts';

const { createGitInventoryServiceMock, createWorktreeServiceMock } = vi.hoisted(() => ({
  createGitInventoryServiceMock: vi.fn(),
  createWorktreeServiceMock: vi.fn(),
}));

vi.mock('../../src/git-workspace/git-inventory-service.ts', () => ({
  createGitInventoryService: createGitInventoryServiceMock,
}));
vi.mock('../../src/git-workspace/worktree-service.ts', () => ({
  createWorktreeService: createWorktreeServiceMock,
}));

function createWorkspace({ store = {} as never, subscribe = true } = {}) {
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
  const workspace = createGitWorkspace({
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    managedWorktreeDirectory: '/home/tester/.brainstrike/worktrees',
    openWorktreeFolder: vi.fn(),
    roots: { listRoots: async () => [] },
    snapshotsBaseDir: '/tmp/brainstrike-git-workspace-test/snapshots',
    store,
  });
  const events: GitWorkspaceEvent[] = [];
  if (subscribe) {
    workspace.service.subscribe((event) => events.push(event));
  }
  return { events, gitInventoryService, workspace, worktreeService };
}

describe('createGitWorkspace', () => {
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
      listThreads: async () => [],
      read: async () => [],
      readLedger: async () => ({ threads: [] }),
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

  it("tells Core which idle worktrees a creation's cap archived, from Core's thread bindings", async () => {
    const worktree = (index: number): ManagedWorktreeRow => {
      const name = `wt-${String(index).padStart(2, '0')}`;
      return {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: 'main',
        branch: `bs/${name}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        createdBy: 'user',
        id: name,
        path: `/managed/app/${name}`,
        repoCommonDir: '/repo/.git',
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: null,
      };
    };
    // Seventeen besides the one just made; the oldest is a thread's folder, by its recorded root.
    const rows = Array.from({ length: 17 }, (_, index) => worktree(index));
    const { workspace, worktreeService } = createWorkspace({
      store: {
        workspaceRoots: async () => ({
          roots: [
            { canonicalPath: '/managed/app/wt-00', id: 'root-wt-00', path: '/managed/app/wt-00' },
          ],
        }),
        worktreeLedger: async () => ({ rows }),
      } as never,
    });
    // The service's archive as the cap calls it: a worktree a thread is bound to is left in place.
    Object.assign(worktreeService, {
      archive: async ({ idleCap, worktreeId }: WorktreeArchiveParams) =>
        (await idleCap?.isBound())
          ? { error: { code: 'worktree.bound' }, ok: false }
          : {
              ok: true,
              value: {
                snapshotRef: `refs/brainstrike/worktree-archive/${worktreeId}`,
                worktree: rows.find(({ id }) => id === worktreeId),
              },
            },
    });
    workspace.attachThreadReads({
      listThreads: async () =>
        [
          {
            binding: { operatingRootDisplayName: 'wt-00', operatingRootId: 'root-wt-00' },
            threadId: 't-2',
          },
          { binding: null, threadId: 't-1' },
        ] as never,
      read: async () => [],
      readLedger: async () => ({ threads: [] }),
    });
    const told: HostIdleWorktreeArchive[] = [];
    workspace.idleWorktreeArchives.subscribe((archive) => told.push(archive));
    const options = createWorktreeServiceMock.mock.calls[0]?.[0] as Pick<
      WorktreeServiceDeps,
      'afterCreate'
    >;

    options.afterCreate?.(worktree(99), {
      baseRef: 'HEAD',
      branch: { name: 'bs/wt-99' },
      createdBy: 'agent',
      name: 'wt-99',
      rootId: 'r-1',
      runId: 'run-1',
      threadId: 't-1',
    });

    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(told).toEqual([
      {
        limit: 15,
        runId: 'run-1',
        threadId: 't-1',
        worktrees: [
          {
            branch: 'bs/wt-01',
            name: 'wt-01',
            snapshotRef: 'refs/brainstrike/worktree-archive/wt-01',
            worktreeId: 'wt-01',
          },
        ],
      },
    ]);
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
