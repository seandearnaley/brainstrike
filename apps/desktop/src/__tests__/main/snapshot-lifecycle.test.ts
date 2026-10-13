import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotService } from '../../assistant-server/snapshot-service';
import { startSnapshotStartupMaintenance } from '../../main/snapshot-lifecycle';

const mocks = vi.hoisted(() => ({
  createRepository: vi.fn(),
  gc: vi.fn(),
  reap: vi.fn(),
}));

vi.mock('../../assistant-server/snapshot-repository', () => ({
  createSnapshotRepository: mocks.createRepository,
}));
vi.mock('../../assistant-server/snapshot-startup-gc', () => ({
  runSnapshotStartupGc: mocks.gc,
}));
vi.mock('../../assistant-server/thread-run-startup-reaper', () => ({
  reapOrphanedThreadRuns: mocks.reap,
}));

const readHostThreadRows = async () => [];
const readHostThreadIds = async (): Promise<ReadonlySet<string>> => new Set(['host-thread']);
const snapshotsBaseDir = '/profile/snapshots';

function setup() {
  const events: string[] = [];
  const service = {
    sweepOrphans: vi.fn(async () => {
      events.push('sweep');
      return { kept: ['root-1'], removed: ['root-2'] };
    }),
  } as unknown as SnapshotService;
  const workspaceRoots = {
    workspaceRoots: vi.fn(async () => {
      events.push('roots');
      return { roots: [{ id: 'root-1', path: '/workspace' }] };
    }),
  };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  mocks.createRepository.mockReturnValue({});
  mocks.reap.mockImplementation(async () => {
    events.push('reap');
    return { reaped: [], reapedBackgroundTaskIds: [] };
  });
  mocks.gc.mockImplementation(async () => {
    events.push('gc');
    return {
      deadThreadsPruned: [],
      failures: [],
      historyPrunedRoots: [],
      hostRingTrimmed: [],
      refOnlyPruned: [],
      ringTrimmed: [],
      skippedInaccessibleRoots: [],
    };
  });
  return { events, logger, service, workspaceRoots };
}

describe('snapshot startup lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts ordered maintenance without blocking its caller', async () => {
    const { workspaceRoots, events, logger, service } = setup();
    const returned = startSnapshotStartupMaintenance({
      logger,
      readHostThreadIds,
      readHostThreadRows,
      snapshotService: service,
      snapshotsBaseDir,
      workspaceRoots: workspaceRoots as never,
    });

    expect(returned).toBeUndefined();
    expect(mocks.gc).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(events).toEqual(['roots', 'sweep', 'gc']));
    expect(mocks.reap).not.toHaveBeenCalled();
    expect(workspaceRoots.workspaceRoots).toHaveBeenCalledWith({ operation: 'list' });
    expect(service.sweepOrphans).toHaveBeenCalledWith(snapshotsBaseDir, ['root-1']);
    expect(mocks.gc).toHaveBeenCalledWith({
      liveRoots: [{ path: '/workspace', rootId: 'root-1' }],
      readHostThreadIds,
      readHostThreadRows,
      readThreadChain: expect.any(Function),
      snapshotService: service,
    });
    expect(mocks.createRepository).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Workspace snapshot startup GC completed',
      expect.objectContaining({ failures: 0 })
    );
  });

  it('does not invoke retired database reaping during host-owned maintenance', async () => {
    const { workspaceRoots, events, logger, service } = setup();
    mocks.reap.mockRejectedValue(new Error('retired database owner'));
    startSnapshotStartupMaintenance({
      logger,
      readHostThreadIds,
      readHostThreadRows,
      snapshotService: service,
      snapshotsBaseDir,
      workspaceRoots: workspaceRoots as never,
    });
    await vi.waitFor(() => expect(events).toEqual(['roots', 'sweep', 'gc']));
    expect(mocks.reap).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports GC item failures without stopping the summary', async () => {
    const { workspaceRoots, logger, service } = setup();
    const failure = { reason: 'unavailable' };
    mocks.gc.mockResolvedValue({
      deadThreadsPruned: [],
      failures: [failure],
      historyPrunedRoots: [],
      hostRingTrimmed: [],
      refOnlyPruned: [],
      ringTrimmed: [],
      skippedInaccessibleRoots: ['/offline'],
    });

    startSnapshotStartupMaintenance({
      logger,
      readHostThreadIds,
      readHostThreadRows,
      snapshotService: service,
      snapshotsBaseDir,
      workspaceRoots: workspaceRoots as never,
    });

    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        'Workspace snapshot startup GC completed',
        expect.objectContaining({ failures: 1 })
      )
    );
    expect(logger.error).toHaveBeenCalledWith('Workspace snapshot GC item failed', { failure });
    expect(logger.warn).toHaveBeenCalledWith('Workspace snapshot GC skipped inaccessible roots', {
      roots: ['/offline'],
    });
  });

  it.each(['roots', 'sweep', 'gc'] as const)(
    'reports a %s failure through the original outer catch and stops later stages',
    async (stage) => {
      const { workspaceRoots, logger, service } = setup();
      const error = new Error(`${stage} failed`);
      switch (stage) {
        case 'roots':
          workspaceRoots.workspaceRoots.mockRejectedValue(error);
          break;
        case 'sweep':
          vi.mocked(service.sweepOrphans).mockRejectedValue(error);
          break;
        case 'gc':
          mocks.gc.mockRejectedValue(error);
          break;
      }

      startSnapshotStartupMaintenance({
        logger,
        readHostThreadIds,
        readHostThreadRows,
        snapshotService: service,
        snapshotsBaseDir,
        workspaceRoots: workspaceRoots as never,
      });

      await vi.waitFor(() =>
        expect(logger.error).toHaveBeenCalledWith('Workspace snapshot orphan sweep failed', {
          error,
          snapshotsBaseDir,
        })
      );
      if (stage === 'roots') {
        expect(service.sweepOrphans).not.toHaveBeenCalled();
      }
      if (stage !== 'gc') {
        expect(mocks.gc).not.toHaveBeenCalled();
      }
    }
  );
});
