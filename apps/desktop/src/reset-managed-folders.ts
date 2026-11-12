/**
 * ADR-0015, ADR-0034: the folders the app made outside its database, which a reset deletes the
 * records of. Factory Reset and Clear Database both archive the managed worktrees into their
 * repositories while the host still serves their ledger; Clear Database also moves the scratch
 * folders to the Trash once their rows are gone (Factory Reset deletes userData, and them, itself).
 * Neither step fails the reset: the person chose it, and whatever stays is named with why.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type {
  ScratchFolderTrash,
  ScratchFolderTrashOutcome,
  WorktreeResetArchive,
  WorktreeResetOutcome,
} from '@brainstrike/types';

const logger = createLogger('DesktopResetFolders');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Archives the managed worktrees before their ledger is deleted. A worktree the archive left, or
 * an archive that could not run, is reported, never fatal, and no worktree folder is deleted
 * outside the archive.
 */
export async function archiveManagedWorktreesForReset(
  archive: () => Promise<BoundaryResult<WorktreeResetArchive>>
): Promise<WorktreeResetOutcome> {
  let answer: BoundaryResult<WorktreeResetArchive>;
  try {
    answer = await archive();
  } catch (error) {
    logger.error('The reset could not archive the managed worktrees', { error });
    return { reason: messageOf(error), status: 'failed' };
  }
  if (!answer.ok) {
    logger.error('The reset could not archive the managed worktrees', { error: answer.error });
    return { reason: answer.error.message, status: 'failed' };
  }
  const { archived, retained } = answer.value;
  if (retained.length > 0) {
    logger.warn('The reset left managed worktrees on disk', { retained });
  }
  return { archived, retained, status: 'archived' };
}

/**
 * Moves the scratch folders to the Trash after Clear Database succeeded, never before: a failed
 * clear keeps the threads those folders belong to. A folder left, or a move that could not run,
 * is reported, never fatal.
 */
export async function trashScratchFoldersAfterClear(
  trash: () => Promise<ScratchFolderTrash>
): Promise<ScratchFolderTrashOutcome> {
  let moved: ScratchFolderTrash;
  try {
    moved = await trash();
  } catch (error) {
    logger.error('Clearing content could not move the scratch folders to the Trash', { error });
    return { reason: messageOf(error), status: 'failed' };
  }
  if (moved.retained.length > 0) {
    logger.warn('Clearing content left scratch folders on disk', { retained: moved.retained });
  }
  return { ...moved, status: 'trashed' };
}
