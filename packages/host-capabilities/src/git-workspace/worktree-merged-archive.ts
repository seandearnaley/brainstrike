/**
 * ADR-0034 build decisions (BST-2504): archive on merge. Each idle managed
 * worktree of a repository whose branch has commits of its own and adds nothing
 * the default branch lacks (`worktree-merged.ts`) is archived the way the idle
 * cap archives: through the worktree service's serialized archive with the
 * cap's skip rules (`archiveIdleWorktree`), which keeps its snapshot ref and its
 * branch and deletes the files git ignores. The archive asks again in its own
 * turn whether the branch still counts as merged.
 *
 * The thread that made each worktree (the ledger's `threadId`) is told, with
 * its latest run. A worktree no thread made, or whose thread is gone or has no
 * run to show the notice with, is archived and logged.
 *
 * The idle cap runs this pass first, in its own queue, so a merged worktree
 * never counts toward the 15 (`worktree-idle-cap.ts`).
 */
import path from 'node:path';
import type { HostIdleWorktreeArchive } from '@brainstrike/agent-host';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type { ManagedWorktreeRow, WorktreeArchiveResult } from '@brainstrike/types';
import { GIT_DEFAULT_TIMEOUT_MS, type GitCommandRunner } from './git-service.ts';
import type { GitInvoke } from './worktree-archive.ts';
import { worktreePathExists } from './worktree-archive-preview.ts';
import { IDLE_ARCHIVE_LEFT_IN_PLACE } from './worktree-idle-archive.ts';
import { type MergeTarget, readWorktreeMerged, resolveMergeTarget } from './worktree-merged.ts';
import type { WorktreeArchiveParams } from './worktree-service-inputs.ts';

const logger = createLogger('MergedWorktreeArchive');

type MergedArchive = Extract<HostIdleWorktreeArchive, { reason: 'merged' }>;

export interface MergedWorktreeArchiveDeps {
  /** The worktree service's serialized archive, called with `idleCap`. */
  readonly archive: (
    params: WorktreeArchiveParams
  ) => Promise<BoundaryResult<WorktreeArchiveResult>>;
  /** Tells a thread which of the worktrees it made were archived. */
  readonly publish: (archive: HostIdleWorktreeArchive) => void;
  /** Git as the host runs it in the person's folders. */
  readonly run: GitCommandRunner;
}

export interface MergedWorktreePass {
  /** True once the host has started to close: no further worktree is archived. */
  readonly closing: () => boolean;
  /** The repository's idle, unarchived worktrees, never one just made. */
  readonly idle: readonly ManagedWorktreeRow[];
  /** Whether a thread is bound to the worktree now, asked in the archive's own turn. */
  readonly isBound: (row: ManagedWorktreeRow) => Promise<boolean>;
  readonly repoCommonDir: string;
  /** Every existing thread, and whether it has a run to show a notice with. */
  readonly threads: readonly { readonly hasRun: boolean; readonly threadId: string }[];
}

function invokeIn(run: GitCommandRunner, cwd: string): GitInvoke {
  return (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) => run({ args, cwd, timeoutMs });
}

/**
 * Archives each idle worktree of the repository whose branch has merged, and tells the threads
 * that made them. Answers the ids it archived.
 */
export async function archiveMergedWorktrees(
  deps: MergedWorktreeArchiveDeps,
  pass: MergedWorktreePass
): Promise<ReadonlySet<string>> {
  const archivedIds = new Set<string>();
  if (pass.idle.length === 0) {
    return archivedIds;
  }
  const { repoCommonDir } = pass;
  const repository = invokeIn(deps.run, repoCommonDir);
  const target = await resolveMergeTarget(repository);
  if (!target.ok) {
    if (target.error.kind === 'refusal') {
      logger.info('Archive on merge does not run in this repository', {
        reason: target.error,
        repoCommonDir,
      });
    } else {
      logger.error('Archive on merge could not read the repository', {
        error: target.error,
        repoCommonDir,
      });
    }
    return archivedIds;
  }
  const check = (row: ManagedWorktreeRow) =>
    readWorktreeMerged({
      repository,
      target: target.value,
      worktree: invokeIn(deps.run, row.path),
    });
  const told = new Map<string, MergedArchive['worktrees']>();
  for (const row of pass.idle) {
    if (pass.closing()) {
      logger.info('The host is closing; archive on merge stops', { repoCommonDir });
      break;
    }
    const context = { repoCommonDir, worktreeId: row.id };
    // A recorded worktree whose folder is gone has no changes to read; it is not merged.
    if (!(await worktreePathExists(row.path))) {
      logger.debug('A worktree whose folder is gone is not checked for a merge', context);
      continue;
    }
    const verdict = await check(row);
    if (!verdict.ok) {
      logger.error('Could not tell whether a worktree has merged', {
        ...context,
        error: verdict.error,
      });
      continue;
    }
    if (!verdict.value.merged) {
      logger.debug('A worktree has not merged', { ...context, reason: verdict.value.reason });
      continue;
    }
    const { branch } = verdict.value;
    const entry = await archiveMerged(deps, row, branch, {
      isBound: () => pass.isBound(row),
      isMerged: async () => {
        const again = await check(row);
        return again.ok && again.value.merged && again.value.branch === branch;
      },
    });
    if (!entry) {
      continue;
    }
    archivedIds.add(row.id);
    const creator = creatorToTell(pass, row);
    if (creator) {
      told.set(creator, [...(told.get(creator) ?? []), entry]);
    }
  }
  for (const [threadId, worktrees] of told) {
    deps.publish(mergedArchive(target.value, threadId, worktrees));
  }
  return archivedIds;
}

function mergedArchive(
  target: MergeTarget,
  threadId: string,
  worktrees: MergedArchive['worktrees']
): MergedArchive {
  return { defaultBranch: target.defaultBranch, reason: 'merged', threadId, worktrees };
}

/** One merged worktree through the service's archive; undefined when it stays. */
async function archiveMerged(
  deps: MergedWorktreeArchiveDeps,
  row: ManagedWorktreeRow,
  branch: string,
  idleCap: NonNullable<WorktreeArchiveParams['idleCap']>
): Promise<MergedArchive['worktrees'][number] | undefined> {
  const context = { repoCommonDir: row.repoCommonDir, worktreeId: row.id };
  const outcome = await deps.archive({ idleCap, worktreeId: row.id });
  if (!outcome.ok) {
    if (IDLE_ARCHIVE_LEFT_IN_PLACE.has(outcome.error.code)) {
      logger.info('Archive on merge left a worktree', { ...context, reason: outcome.error });
    } else {
      logger.error('Archive on merge could not archive a worktree', {
        ...context,
        error: outcome.error,
      });
    }
    return;
  }
  const { snapshotRef, worktree } = outcome.value;
  logger.info('Archived a worktree whose branch has merged', { ...context, branch, snapshotRef });
  return { branch, name: path.basename(worktree.path), snapshotRef, worktreeId: worktree.id };
}

/** The thread that made the worktree, when it exists and has a run to show the notice with. */
function creatorToTell(pass: MergedWorktreePass, row: ManagedWorktreeRow): string | undefined {
  const context = { threadId: row.threadId, worktreeId: row.id };
  if (row.threadId === null) {
    logger.info('A merged worktree no thread made was archived; no one is told', context);
    return;
  }
  const creator = pass.threads.find(({ threadId }) => threadId === row.threadId);
  if (!creator) {
    logger.info('The thread that made a merged worktree is gone; no one is told', context);
    return;
  }
  if (!creator.hasRun) {
    logger.info('The thread that made a merged worktree has no run to show the notice', context);
    return;
  }
  return creator.threadId;
}
