import type { createLogger } from '@brainstrike/logging';
import type { EditCheckpointDatabase } from '../assistant-server/edit-checkpoint-journal';
import { createSnapshotRepository } from '../assistant-server/snapshot-repository';
import type { SnapshotService } from '../assistant-server/snapshot-service';
import { runSnapshotStartupGc } from '../assistant-server/snapshot-startup-gc';
import { reapOrphanedThreadRuns } from '../assistant-server/thread-run-startup-reaper';
import type { getDatabase as getDesktopDatabase } from '../db-main';

export interface SnapshotStartupMaintenanceDeps {
  readonly getDatabase: typeof getDesktopDatabase;
  readonly logger: Pick<ReturnType<typeof createLogger>, 'error' | 'info' | 'warn'>;
  readonly mainProcessStartedAt: Date;
  /** The agent host's live thread ids: their turn snapshots live in its log. */
  readonly readHostThreadIds: () => Promise<ReadonlySet<string>>;
  readonly snapshotService: SnapshotService;
  readonly snapshotsBaseDir: string;
}

/** Start non-blocking maintenance after main publishes the app-ready service. */
export function startSnapshotStartupMaintenance({
  getDatabase,
  logger,
  mainProcessStartedAt,
  readHostThreadIds,
  snapshotService,
  snapshotsBaseDir,
}: SnapshotStartupMaintenanceDeps): void {
  // Startup orphan sweep: remove shadow repos whose workspace root row no
  // longer EXISTS at all. Deliberately keyed on every `roots` row (any
  // status), NOT on `status = 'live'`: disconnect ≠ delete (the row is
  // kept and the root can reconnect), and sweeping a disconnected root
  // here would irreversibly destroy its snapshot history. Fire-and-forget
  // so startup never blocks on it; failures are logged visibly, never
  // swallowed.
  void (async () => {
    try {
      const database = await getDatabase();
      // BST-1162: unstick rewind's in-flight gate. Rows a previous
      // process left in 'running' are provably dead (see the reaper's
      // evidence rule); marking them failed here is what re-enables
      // Conversation Rewind on their threads. Runs before the snapshot
      // GC on purpose (its retention floor walks run ranges), but in its
      // OWN try/catch: a reap failure must neither skip the orphan sweep
      // and GC below nor report itself under their step name.
      try {
        const reapReport = await reapOrphanedThreadRuns(
          database as unknown as EditCheckpointDatabase,
          mainProcessStartedAt
        );
        if (reapReport.reaped.length > 0 || reapReport.reapedBackgroundTaskIds.length > 0) {
          logger.info('Startup thread-run reap completed', {
            reapedBackgroundTaskIds: reapReport.reapedBackgroundTaskIds,
            reapedRunIds: reapReport.reaped.map((row) => row.id),
          });
        }
      } catch (reapError) {
        logger.error('Startup thread-run reap failed', { error: reapError });
      }
      const rootRows = await database.query<{ id: string; path: string }>(
        'SELECT id, path FROM roots'
      );
      const result = await snapshotService.sweepOrphans(
        snapshotsBaseDir,
        rootRows.rows.map((row) => row.id)
      );
      logger.info('Workspace snapshot orphan sweep completed', {
        kept: result.kept.length,
        removed: result.removed,
        snapshotsBaseDir,
      });
      // T4 startup GC (after the orphan sweep so vanished-root repos are
      // already gone): dead-thread rows + refs, ref-only residue, the
      // 50-turn retention ring, and shallow-cut history reclamation.
      // Same fire-and-forget block — logged, non-blocking, failures
      // visible per item.
      const gcDatabase = database as unknown as EditCheckpointDatabase;
      const gcReport = await runSnapshotStartupGc({
        db: gcDatabase,
        liveRoots: rootRows.rows.map((row) => ({ path: row.path, rootId: row.id })),
        readHostThreadIds,
        snapshotRepository: createSnapshotRepository(gcDatabase),
        snapshotService,
      });
      for (const failure of gcReport.failures) {
        logger.error('Workspace snapshot GC item failed', { failure });
      }
      if (gcReport.skippedInaccessibleRoots.length > 0) {
        // Expected condition (deleted directory / unmounted volume), so a
        // single warn — not one error per boot forever.
        logger.warn('Workspace snapshot GC skipped inaccessible roots', {
          roots: gcReport.skippedInaccessibleRoots,
        });
      }
      logger.info('Workspace snapshot startup GC completed', {
        deadThreadsPruned: gcReport.deadThreadsPruned.length,
        failures: gcReport.failures.length,
        historyPrunedRoots: gcReport.historyPrunedRoots,
        refOnlyPruned: gcReport.refOnlyPruned.length,
        ringTrimmed: gcReport.ringTrimmed,
        skippedInaccessibleRoots: gcReport.skippedInaccessibleRoots.length,
      });
    } catch (error) {
      logger.error('Workspace snapshot orphan sweep failed', { error, snapshotsBaseDir });
    }
  })();
}
