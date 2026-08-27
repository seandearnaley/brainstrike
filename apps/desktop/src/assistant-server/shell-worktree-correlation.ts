/**
 * Shell-output correlation (BST-1392, spec §6.4): when the agent's own
 * `executeCommand` ran `git worktree …` or `gh pr create`, ask the authorities
 * what actually changed.
 *
 * BEST-EFFORT AND FIRE-AND-FORGET, on purpose. Reconciliation runs AFTER the
 * tool result exists and never blocks, delays, or fails the tool call — a
 * breadcrumb must not be able to break the thing it describes. Safe worktree
 * attribution still depends on a synchronous pre-command snapshot taken by
 * the caller; this module neither produces nor interprets that snapshot, it
 * only forwards it to the reconciler. Every failure is logged with identity
 * only; the command text never reaches a log or a run event.
 *
 * It correlates from the TOOL RESULT, never from the git-metadata watcher: that
 * signal carries only `{ gitCommonDir, repositoryRoot }` with no
 * create-vs-remove discrimination and a 300–2000 ms coalescing window, so
 * attributing it to a run would be a temporal guess. See
 * docs/agents/assistant-persistence.md.
 */
import { scanShellCommandForGitSignals } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { GitResult } from '@brainstrike/types';
import type { WorktreeShellReconcileResult } from './worktree-adopt';

const logger = createLogger('ShellWorktreeCorrelation');

export interface ShellCorrelationCapability {
  readonly onCommandCompleted: (input: {
    readonly command: string;
    readonly precedingWorktreePaths: ReadonlySet<string> | undefined;
    readonly rootId: string;
  }) => void;
}

export function createShellCorrelation(deps: {
  readonly forgeRefresh: (rootId: string) => void;
  readonly reconcile: (
    rootId: string,
    precedingWorktreePaths: ReadonlySet<string> | undefined
  ) => Promise<GitResult<WorktreeShellReconcileResult>>;
}): ShellCorrelationCapability {
  return {
    onCommandCompleted: ({ command, precedingWorktreePaths, rootId }) => {
      const signals = scanShellCommandForGitSignals(command);
      if (signals.touchedWorktrees) {
        void deps
          .reconcile(rootId, precedingWorktreePaths)
          .then((result) => {
            if (result.ok) {
              logger.info('shell worktree reconcile completed', {
                adopted: result.value.adopted.length,
                likelyMoves: result.value.likelyMoves.length,
                rootId,
                vanished: result.value.vanishedLedgerIds.length,
              });
              return;
            }
            logger.warn('shell worktree reconcile refused', { reason: result.error, rootId });
          })
          .catch((error: unknown) => {
            logger.error('shell worktree reconcile threw', { error, rootId });
          });
      }
      if (signals.createdPullRequest) {
        try {
          deps.forgeRefresh(rootId);
        } catch (error) {
          logger.error('shell forge refresh threw', { error, rootId });
        }
      }
    },
  };
}
