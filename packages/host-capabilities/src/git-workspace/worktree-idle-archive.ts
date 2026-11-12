/**
 * ADR-0034 decision 7: the idle-worktree cap's archive, inside the worktree
 * service's own serialized archive turn (`archive` with `idleCap`).
 *
 * The cap never archives a worktree a thread is bound to, a locked one, one
 * with nested repositories or one a run is active in: each is a refusal the
 * cap reads as "left in place". Anything else that would block a person's
 * archive (uncommitted changes, unpushed commits, ignored files) is forced:
 * the snapshot keeps the work, the branch stays, and the ignored files'
 * deletion is confirmed with the archive preview's own token.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ManagedWorktreeRow, WorktreeArchiveResult } from '@brainstrike/types';
import { gitRefused } from './git-failure.ts';
import {
  findNestedRepositories,
  type GitInvoke,
  readWorktreeLock,
  type WorktreeSafetyReport,
} from './worktree-archive.ts';
import {
  inspectWorktreeArchivePreviewForPath,
  worktreePathExists,
} from './worktree-archive-preview.ts';
import type { WorktreeLedger } from './worktree-ledger.ts';
import type { WorktreeArchiveParams } from './worktree-service-inputs.ts';

/** The refusals that mean the cap left a worktree in place, not that its archive failed. */
export const IDLE_ARCHIVE_LEFT_IN_PLACE: ReadonlySet<string> = new Set([
  'worktree.bound',
  'worktree.locked',
  'worktree.nested-repositories',
  'worktree.not-active',
  'worktree.run-active',
]);

/** The service's own parts the cap's archive runs through. */
export interface IdleArchiveService {
  /** The person's archive, in the same turn. */
  readonly archive: (
    params: WorktreeArchiveParams
  ) => Promise<BoundaryResult<WorktreeArchiveResult>>;
  readonly inspectArchiveRow: (
    row: ManagedWorktreeRow
  ) => Promise<BoundaryResult<WorktreeSafetyReport>>;
  readonly invokeIn: (cwd: string) => GitInvoke;
  readonly ledger: Pick<WorktreeLedger, 'get' | 'hasRunningThread'>;
}

/** Why the cap may not archive the worktree, as a refusal; null when it may. */
async function leftInPlace(
  service: IdleArchiveService,
  row: ManagedWorktreeRow,
  isBound: () => Promise<boolean>
): Promise<BoundaryResult<never> | null> {
  if (await isBound()) {
    return gitRefused('conflict', 'worktree.bound', 'A thread works in this worktree.');
  }
  if (await service.ledger.hasRunningThread(row.id)) {
    return gitRefused('conflict', 'worktree.run-active', 'A run is active in this worktree.');
  }
  const lock = await readWorktreeLock({
    invoke: service.invokeIn(row.repoCommonDir),
    worktreePath: row.path,
  });
  if (!lock.ok) {
    return lock;
  }
  if (lock.value !== null) {
    return gitRefused('conflict', 'worktree.locked', 'This worktree is locked.');
  }
  if (!(await worktreePathExists(row.path))) {
    return null;
  }
  const nested = await findNestedRepositories({
    invoke: service.invokeIn(row.path),
    worktreePath: row.path,
  });
  if (!nested.ok) {
    return nested;
  }
  return nested.value.length > 0
    ? gitRefused(
        'conflict',
        'worktree.nested-repositories',
        'This worktree holds nested repositories, which its archive cannot keep.'
      )
    : null;
}

export async function archiveIdleWorktree(
  service: IdleArchiveService,
  worktreeId: string,
  idleCap: NonNullable<WorktreeArchiveParams['idleCap']>
): Promise<BoundaryResult<WorktreeArchiveResult>> {
  const row = await service.ledger.get(worktreeId);
  if (!row || row.archivedAt !== null) {
    return gitRefused(
      'conflict',
      'worktree.not-active',
      `Managed worktree "${worktreeId}" is not active.`
    );
  }
  const refusal = await leftInPlace(service, row, idleCap.isBound);
  if (refusal) {
    return refusal;
  }
  const preview = await inspectWorktreeArchivePreviewForPath({
    inspectSafety: () => service.inspectArchiveRow(row),
    path: row.path,
  });
  if (!preview.ok) {
    return preview;
  }
  const token = preview.value.confirmationToken;
  return await service.archive({
    ...(token === null ? {} : { confirmIgnoredEntries: token }),
    force: true,
    worktreeId,
  });
}
