import { createLogger } from '@brainstrike/logging';
import type { WorktreeResetOutcome } from '@brainstrike/types';
import { toast } from '@brainstrike/ui';
import { useEffect } from 'react';

const logger = createLogger('FactoryResetOutcome');

const worktrees = (count: number): string => (count === 1 ? '1 worktree' : `${count} worktrees`);

function archivedLine(count: number): string {
  return count === 1
    ? "1 worktree was archived: its work is in its repository's refs/brainstrike/worktree-archive/* and its branch."
    : `${count} worktrees were archived: their work is in each repository's refs/brainstrike/worktree-archive/* and their branches.`;
}

function showOutcome(outcome: WorktreeResetOutcome): void {
  if (outcome.status === 'failed') {
    toast({
      description: `${outcome.reason} Their folders are still on disk, outside the app.`,
      persistent: true,
      title: 'Factory reset could not archive your worktrees',
      variant: 'destructive',
    });
    return;
  }
  const { archived, retained } = outcome;
  if (retained.length === 0) {
    if (archived.length > 0) {
      toast({ title: `${worktrees(archived.length)} archived into their repositories` });
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
    title: `Factory reset left ${worktrees(retained.length)} on disk`,
    variant: 'destructive',
  });
}

/**
 * ADR-0034: Factory Reset archives the managed worktrees before it deletes their ledger. The
 * window that asked for the reset is replaced before the reset answers it, so the replacement
 * window takes the outcome from Main once, as it starts, and tells the person: each worktree
 * left on disk with why, or why none could be archived, or how many were.
 */
export function useFactoryResetOutcomeNotice(): void {
  useEffect(() => {
    const take = window.electronAPI?.factoryReset.takeWorktreeOutcome;
    if (!take) {
      return;
    }
    // Taken once: the toast store outlives this effect, so a remount never loses it.
    take().then(
      (outcome) => {
        if (outcome) {
          showOutcome(outcome);
        }
      },
      (error: unknown) => {
        logger.error('Could not read what the factory reset did with the worktrees', { error });
      }
    );
  }, []);
}
