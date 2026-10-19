import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotService } from '../../assistant-server/snapshot-service';
import { startSnapshotStartupMaintenance } from '../../main/snapshot-lifecycle';

const mocks = vi.hoisted(() => ({
  createRepository: vi.fn(),
  gc: vi.fn(),
}));

vi.mock('../../assistant-server/snapshot-repository', () => ({
  createSnapshotRepository: mocks.createRepository,
}));
vi.mock('../../assistant-server/snapshot-startup-gc', () => ({
  runSnapshotStartupGc: mocks.gc,
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

    expect(returned).toEqual({ stop: expect.any(Function) });
    expect(mocks.gc).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(events).toEqual(['roots', 'sweep', 'gc']));
    expect(workspaceRoots.workspaceRoots).toHaveBeenCalledWith({ operation: 'list' });
    expect(service.sweepOrphans).toHaveBeenCalledWith(snapshotsBaseDir, ['root-1']);
    expect(mocks.gc).toHaveBeenCalledWith({
      liveRoots: [{ path: '/workspace', rootId: 'root-1' }],
      readHostThreadIds,
      readHostThreadRows,
      readThreadChain: expect.any(Function),
      signal: expect.any(AbortSignal),
      snapshotService: service,
    });
    expect(mocks.createRepository).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Workspace snapshot startup GC completed',
      expect.objectContaining({ failures: 0 })
    );
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

  // BST-1859: the graceful shutdown stops the pass and joins the stage in flight
  // before the agent host, the database and git retire under it.
  it.each([
    ['roots', 'orphan sweep'],
    ['sweep', 'startup GC'],
  ] as const)(
    'a stop during the %s stage joins it and starts no later stage',
    async (stage, before) => {
      const { workspaceRoots, events, logger, service } = setup();
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      if (stage === 'roots') {
        workspaceRoots.workspaceRoots.mockImplementation(async () => {
          events.push('roots');
          entered.resolve();
          await held.promise;
          return { roots: [{ id: 'root-1', path: '/workspace' }] };
        });
      } else {
        vi.mocked(service.sweepOrphans).mockImplementation(async () => {
          events.push('sweep');
          entered.resolve();
          await held.promise;
          return { kept: ['root-1'], removed: [] };
        });
      }
      const maintenance = startSnapshotStartupMaintenance({
        logger,
        readHostThreadIds,
        readHostThreadRows,
        snapshotService: service,
        snapshotsBaseDir,
        workspaceRoots: workspaceRoots as never,
      });
      await entered.promise;

      let joined = false;
      const stopping = maintenance.stop().then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      held.resolve();
      await stopping;

      expect(events).toEqual(stage === 'roots' ? ['roots'] : ['roots', 'sweep']);
      expect(mocks.gc).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Workspace snapshot startup maintenance stopped: the app is quitting',
        { before }
      );
      expect(logger.error).not.toHaveBeenCalled();
    }
  );

  it('a stop during GC aborts its signal, joins it, and logs the pass as stopped', async () => {
    const { workspaceRoots, logger, service } = setup();
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<AbortSignal>();
    mocks.gc.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      entered.resolve(signal);
      await held.promise;
      return {
        deadThreadsPruned: [],
        failures: [],
        historyPrunedRoots: [],
        hostRingTrimmed: [],
        refOnlyPruned: [],
        ringTrimmed: [],
        skippedInaccessibleRoots: [],
        stopped: signal.aborted,
      };
    });
    const maintenance = startSnapshotStartupMaintenance({
      logger,
      readHostThreadIds,
      readHostThreadRows,
      snapshotService: service,
      snapshotsBaseDir,
      workspaceRoots: workspaceRoots as never,
    });
    const signal = await entered.promise;
    expect(signal.aborted).toBe(false);

    let joined = false;
    const stopping = maintenance.stop().then(() => {
      joined = true;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(joined).toBe(false);
    held.resolve();
    await stopping;

    expect(logger.info).toHaveBeenCalledWith(
      'Workspace snapshot startup GC stopped: the app is quitting',
      expect.objectContaining({ failures: 0 })
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      'Workspace snapshot startup GC completed',
      expect.anything()
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a stop after the pass finished resolves at once', async () => {
    const { workspaceRoots, events, logger, service } = setup();
    const maintenance = startSnapshotStartupMaintenance({
      logger,
      readHostThreadIds,
      readHostThreadRows,
      snapshotService: service,
      snapshotsBaseDir,
      workspaceRoots: workspaceRoots as never,
    });
    await vi.waitFor(() => expect(events).toEqual(['roots', 'sweep', 'gc']));
    await expect(maintenance.stop()).resolves.toBeUndefined();
    expect(logger.info).not.toHaveBeenCalledWith(
      'Workspace snapshot startup maintenance stopped: the app is quitting',
      expect.anything()
    );
  });
});
