import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { listThreadSnapshotChain } from '../assistant-server/snapshot-chains';
import { execFileSnapshotGitRunner } from '../assistant-server/snapshot-git';
import type { SnapshotService } from '../assistant-server/snapshot-service';
import { runSnapshotStartupGc } from '../assistant-server/snapshot-startup-gc';

export interface SnapshotStartupMaintenanceDeps {
  readonly logger: Pick<ReturnType<typeof createLogger>, 'error' | 'info' | 'warn'>;
  /** The agent host's live thread ids: their turn snapshots live in its log. */
  readonly readHostThreadIds: () => Promise<ReadonlySet<string>>;
  readonly readHostThreadRows: (threadId: string) => Promise<readonly HostLogRow[]>;
  readonly snapshotService: SnapshotService;
  readonly snapshotsBaseDir: string;
  readonly workspaceRoots: WorkspaceRootPort;
}

/** Start non-blocking maintenance after main publishes the app-ready service. */
export function startSnapshotStartupMaintenance({
  workspaceRoots,
  logger,
  readHostThreadIds,
  readHostThreadRows,
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
      const { roots } = await workspaceRoots.workspaceRoots({ operation: 'list' });
      const result = await snapshotService.sweepOrphans(
        snapshotsBaseDir,
        roots.map((row) => row.id)
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
      const gcReport = await runSnapshotStartupGc({
        liveRoots: roots.map((row) => ({ path: row.path, rootId: row.id })),
        readHostThreadIds,
        readHostThreadRows,
        // Host chains are trimmed from the shadow repo itself, never the host's log.
        readThreadChain: (handle, threadId) =>
          listThreadSnapshotChain(execFileSnapshotGitRunner, handle, threadId),
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
        hostRingTrimmed: gcReport.hostRingTrimmed,
        refOnlyPruned: gcReport.refOnlyPruned.length,
        ringTrimmed: gcReport.ringTrimmed,
        skippedInaccessibleRoots: gcReport.skippedInaccessibleRoots.length,
      });
    } catch (error) {
      logger.error('Workspace snapshot orphan sweep failed', { error, snapshotsBaseDir });
    }
  })();
}
