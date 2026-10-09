import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotService } from '../../assistant-server/snapshot-service';
import type { getDatabase } from '../../db-main';
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

const startedAt = new Date('2026-09-25T00:00:00.000Z');
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
  const database = {
    query: vi.fn(async () => {
      events.push('roots');
      return { rows: [{ id: 'root-1', path: '/workspace' }] };
    }),
  };
  const getCurrentDatabase = vi.fn(async () => {
    events.push('database');
    return database;
  }) as unknown as typeof getDatabase;
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
  return { database, events, getCurrentDatabase, logger, service };
}

describe('snapshot startup lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts ordered maintenance without blocking its caller', async () => {
    const { database, events, getCurrentDatabase, logger, service } = setup();
    const returned = startSnapshotStartupMaintenance({
      getDatabase: getCurrentDatabase,
      logger,
      mainProcessStartedAt: startedAt,
      readHostThreadIds,
      snapshotService: service,
      snapshotsBaseDir,
    });

    expect(returned).toBeUndefined();
    expect(mocks.gc).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(events).toEqual(['database', 'reap', 'roots', 'sweep', 'gc']));
    expect(mocks.reap).toHaveBeenCalledWith(database, startedAt);
    expect(database.query).toHaveBeenCalledWith('SELECT id, path FROM roots');
    expect(service.sweepOrphans).toHaveBeenCalledWith(snapshotsBaseDir, ['root-1']);
    expect(mocks.gc).toHaveBeenCalledWith({
      db: database,
      liveRoots: [{ path: '/workspace', rootId: 'root-1' }],
      readHostThreadIds,
      readThreadChain: expect.any(Function),
      snapshotRepository: expect.any(Object),
      snapshotService: service,
    });
    expect(mocks.createRepository).toHaveBeenCalledWith(database);
    expect(logger.info).toHaveBeenCalledWith(
      'Workspace snapshot startup GC completed',
      expect.objectContaining({ failures: 0 })
    );
  });

  it('logs a failed reap and still sweeps and runs GC', async () => {
    const { events, getCurrentDatabase, logger, service } = setup();
    const error = new Error('reap failed');
    mocks.reap.mockImplementation(async () => {
      events.push('reap');
      throw error;
    });

    startSnapshotStartupMaintenance({
      getDatabase: getCurrentDatabase,
      logger,
      mainProcessStartedAt: startedAt,
      readHostThreadIds,
      snapshotService: service,
      snapshotsBaseDir,
    });

    await vi.waitFor(() => expect(events).toEqual(['database', 'reap', 'roots', 'sweep', 'gc']));
    expect(logger.error).toHaveBeenCalledWith('Startup thread-run reap failed', { error });
    expect(logger.error).not.toHaveBeenCalledWith(
      'Workspace snapshot orphan sweep failed',
      expect.anything()
    );
  });

  it('reports GC item failures without stopping the summary', async () => {
    const { getCurrentDatabase, logger, service } = setup();
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
      getDatabase: getCurrentDatabase,
      logger,
      mainProcessStartedAt: startedAt,
      readHostThreadIds,
      snapshotService: service,
      snapshotsBaseDir,
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

  it.each(['database', 'roots', 'sweep', 'gc'] as const)(
    'reports a %s failure through the original outer catch and stops later stages',
    async (stage) => {
      const { database, getCurrentDatabase, logger, service } = setup();
      const error = new Error(`${stage} failed`);
      switch (stage) {
        case 'database':
          vi.mocked(getCurrentDatabase).mockRejectedValue(error);
          break;
        case 'roots':
          database.query.mockRejectedValue(error);
          break;
        case 'sweep':
          vi.mocked(service.sweepOrphans).mockRejectedValue(error);
          break;
        case 'gc':
          mocks.gc.mockRejectedValue(error);
          break;
      }

      startSnapshotStartupMaintenance({
        getDatabase: getCurrentDatabase,
        logger,
        mainProcessStartedAt: startedAt,
        readHostThreadIds,
        snapshotService: service,
        snapshotsBaseDir,
      });

      await vi.waitFor(() =>
        expect(logger.error).toHaveBeenCalledWith('Workspace snapshot orphan sweep failed', {
          error,
          snapshotsBaseDir,
        })
      );
      if (stage === 'database') {
        expect(mocks.reap).not.toHaveBeenCalled();
      }
      if (stage === 'database' || stage === 'roots') {
        expect(service.sweepOrphans).not.toHaveBeenCalled();
      }
      if (stage !== 'gc') {
        expect(mocks.gc).not.toHaveBeenCalled();
      }
    }
  );
});
