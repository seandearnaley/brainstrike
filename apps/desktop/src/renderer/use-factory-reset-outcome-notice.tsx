import { createLogger } from '@brainstrike/logging';
import type {
  ResetOutcome,
  ScratchFolderTrashOutcome,
  WorktreeResetOutcome,
} from '@brainstrike/types';
import { toast } from '@brainstrike/ui';
import { useEffect } from 'react';

const logger = createLogger('FactoryResetOutcome');

/** How the notice names the reset the person chose. */
const RESET_NAME: Record<ResetOutcome['mode'], string> = {
  content: 'Clearing content',
  factory: 'Factory reset',
};

const worktrees = (count: number): string => (count === 1 ? '1 worktree' : `${count} worktrees`);
const scratchFolders = (count: number): string =>
  count === 1 ? '1 scratch folder' : `${count} scratch folders`;

function archivedLine(count: number): string {
  return count === 1
    ? "1 worktree was archived: its work is in its repository's refs/brainstrike/worktree-archive/* and its branch."
    : `${count} worktrees were archived: their work is in each repository's refs/brainstrike/worktree-archive/* and their branches.`;
}

function showWorktreeOutcome(reset: string, outcome: WorktreeResetOutcome): void {
  if (outcome.status === 'failed') {
    toast({
      description: `${outcome.reason} Their folders are still on disk, outside the app.`,
      persistent: true,
      title: `${reset} could not archive your worktrees`,
      variant: 'destructive',
    });
    return;
  }
  const { archived, retained } = outcome;
  if (retained.length === 0) {
    if (archived.length > 0) {
      toast({
        title:
          archived.length === 1
            ? '1 worktree archived into its repository'
            : `${archived.length} worktrees archived into their repositories`,
      });
    }
    return;
  }
  toast({
    description: (
      <div className="space-y-1">
        <ul className="space-y-1">
          {retained.map(({ path, reason, worktreeId }) => (
            <li key={worktreeId}>{`${path}: ${reason}`}</li>
          ))}
        </ul>
        {archived.length > 0 ? <p>{archivedLine(archived.length)}</p> : null}
      </div>
    ),
    persistent: true,
    title: `${reset} left ${worktrees(retained.length)} on disk`,
    variant: 'destructive',
  });
}

function showScratchOutcome(reset: string, outcome: ScratchFolderTrashOutcome): void {
  if (outcome.status === 'failed') {
    toast({
      description: `${outcome.reason} Their folders are still on disk, outside the app.`,
      persistent: true,
      title: `${reset} could not move your scratch folders to the Trash`,
      variant: 'destructive',
    });
    return;
  }
  const { retained, trashed } = outcome;
  if (retained.length === 0) {
    if (trashed.length > 0) {
      toast({ title: `${scratchFolders(trashed.length)} moved to the Trash` });
    }
    return;
  }
  toast({
    description: (
      <div className="space-y-1">
        <ul className="space-y-1">
          {/* Each reason names its folder. */}
          {retained.map(({ path, reason }) => (
            <li key={path}>{reason}</li>
          ))}
        </ul>
        {trashed.length > 0 ? (
          <p>{`${scratchFolders(trashed.length)} ${trashed.length === 1 ? 'was' : 'were'} moved to the Trash.`}</p>
        ) : null}
      </div>
    ),
    persistent: true,
    title: `${reset} left ${scratchFolders(retained.length)} on disk`,
    variant: 'destructive',
  });
}

/**
 * ADR-0034: Factory Reset and Clear Database archive the managed worktrees before they delete
 * their ledger, and Clear Database moves the scratch folders to the Trash after it. The window
 * that asked for the reset is replaced before the reset answers it, so the replacement window
 * takes the outcome from Main once, as it starts, and tells the person: each folder left on disk
 * with why, or why none could be handled, or how many were.
 */
export function useFactoryResetOutcomeNotice(): void {
  useEffect(() => {
    const take = window.electronAPI?.factoryReset.takeResetOutcome;
    if (!take) {
      return;
    }
    // Taken once: the toast store outlives this effect, so a remount never loses it.
    take().then(
      (outcome) => {
        if (!outcome) {
          return;
        }
        const reset = RESET_NAME[outcome.mode];
        if (outcome.managedWorktrees) {
          showWorktreeOutcome(reset, outcome.managedWorktrees);
        }
        if (outcome.scratchFolders) {
          showScratchOutcome(reset, outcome.scratchFolders);
        }
      },
      (error: unknown) => {
        logger.error('Could not read what the reset did with the worktrees and scratch folders', {
          error,
        });
      }
    );
  }, []);
}
