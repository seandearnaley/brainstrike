/**
 * ADR-0015, ADR-0034: a reset archives every active managed worktree before Main deletes their
 * ledger: Factory Reset with the state DB, Clear Database with its rows. Without it the folders would stay on disk, unknown to the
 * app and still registered with their repositories, holding the person's uncommitted work.
 *
 * Each worktree goes through the idle cap's archive (`worktree-idle-archive.ts`), the person's
 * archive under it: the snapshot ref keeps its uncommitted changes in its repository, the branch
 * stays, and the folder and git's registration go. Both resets delete every thread, so no
 * worktree counts as bound. A locked worktree, one with nested repositories and one a run is
 * active in are left in place, never forced; so is one whose archive fails. Each is named with
 * its path and why, and nothing removes a worktree folder outside the archive.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type {
  WorktreeResetArchive,
  WorktreeResetArchived,
  WorktreeResetRetained,
} from '@brainstrike/types';
import { gitRefused, gitThrew } from './git-failure.ts';
import { archiveIdleWorktree, type IdleArchiveService } from './worktree-idle-archive.ts';
import type { WorktreeLedger } from './worktree-ledger.ts';
import type { WorktreeOperationLifetime } from './worktree-operation-lifetime.ts';
import type { createMutex } from './worktree-service-inputs.ts';

const logger = createLogger('WorktreeService');

export interface ResetArchiveService extends IdleArchiveService {
  readonly ledger: Pick<WorktreeLedger, 'get' | 'hasRunningThread' | 'listActive'>;
}

/** A reset deletes every thread, so none holds a worktree. */
const NO_THREAD_REMAINS = { isBound: async () => false } as const;

/** Archives each active worktree in turn; one that stays never stops the next. */
async function archiveEveryWorktree(service: ResetArchiveService): Promise<WorktreeResetArchive> {
  const archived: WorktreeResetArchived[] = [];
  const retained: WorktreeResetRetained[] = [];
  for (const row of await service.ledger.listActive()) {
    let outcome: Awaited<ReturnType<typeof archiveIdleWorktree>>;
    try {
      outcome = await archiveIdleWorktree(service, row.id, NO_THREAD_REMAINS);
    } catch (cause) {
      outcome = gitThrew(cause);
    }
    if (outcome.ok) {
      archived.push({
        path: row.path,
        snapshotRef: outcome.value.snapshotRef,
        worktreeId: row.id,
      });
    } else {
      retained.push({
        code: outcome.error.code,
        path: row.path,
        reason: outcome.error.message,
        worktreeId: row.id,
      });
    }
  }
  return { archived, retained };
}

/**
 * The reset's archive takes one turn of the service's queue, and after it the service makes and
 * restores no worktree. The host closes next (both resets retire it), so nothing reopens it: a
 * run still in progress makes no worktree the reset would leave on disk unnamed.
 */
export function createWorktreeResetArchive(
  serialize: ReturnType<typeof createMutex>,
  lifetime: WorktreeOperationLifetime,
  service: ResetArchiveService
) {
  let archivedForReset = false;
  return {
    archive: (): Promise<BoundaryResult<WorktreeResetArchive>> =>
      serialize(async () => {
        archivedForReset = true;
        try {
          const outcome = await archiveEveryWorktree(service);
          logger.info('the reset archived the managed worktrees', {
            archived: outcome.archived.length,
            retained: outcome.retained,
          });
          return { ok: true, value: outcome };
        } catch (error) {
          logger.error('the reset could not archive the managed worktrees', { error });
          return lifetime.faultResult(error);
        }
      }),
    /** A creation or a restore, in its turn of the queue: refused once the reset has archived. */
    making: <T>(task: () => Promise<BoundaryResult<T>>): Promise<BoundaryResult<T>> =>
      serialize(async () =>
        archivedForReset
          ? gitRefused(
              'availability',
              'worktree.resetting',
              'The app is resetting, so it makes no worktree.'
            )
          : await task()
      ),
  };
}
