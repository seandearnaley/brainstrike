/**
 * What a Conversation Rewind actually did, per root (BST-1115).
 *
 * THE MULTI-ROOT BAR, rendered. `rootOutcomes` covers EVERY root the revert
 * plan touched — including one that produced zero successful reverts and one
 * that is no longer connected (`rootPath: null`) — so this iterates the list
 * the service returned rather than filtering it to the roots that "worked".
 * Absence from this table is never how a root's outcome is communicated, and a
 * root that was silently skipped would therefore be a visible zero, not an
 * invisible gap.
 *
 * Files that did NOT revert are named individually underneath, for the same
 * partial-failure honesty reason: a count is not a report.
 */
import type {
  AssistantRewindFileOutcome,
  AssistantRewindRootOutcome,
} from '@brainstrike/assistant-contract';
import type { ReactElement } from 'react';
import { REWIND_SHELL_CAPTURE_QUALIFIER } from './rewind-copy';

export function RewindOutcomeSummary({
  fileOutcomes,
  rootOutcomes,
  tombstonedCount,
}: {
  readonly fileOutcomes: readonly AssistantRewindFileOutcome[];
  readonly rootOutcomes: readonly AssistantRewindRootOutcome[];
  readonly tombstonedCount: number;
}): ReactElement {
  const unreverted = fileOutcomes.filter((outcome) => outcome.code !== 'reverted');
  // Gated on a NON-EMPTY reverted set: after a rewind that restored files, "we
  // put your files back" is the claim the qualifier has to bound. A rewind that
  // restored nothing makes no such claim, and repeating the caveat there would
  // be noise. Once, never per-file — see REWIND_SHELL_CAPTURE_QUALIFIER.
  const revertedAnything = fileOutcomes.some((outcome) => outcome.code === 'reverted');

  return (
    <div className="flex flex-col gap-3" data-testid="rewind-outcome-summary">
      <p className="text-sm" data-testid="rewind-outcome-messages">
        {tombstonedCount} message{tombstonedCount === 1 ? '' : 's'} hidden.
      </p>

      {revertedAnything ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid="rewind-outcome-shell-capture-notice"
        >
          {REWIND_SHELL_CAPTURE_QUALIFIER}
        </p>
      ) : null}

      {rootOutcomes.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="rewind-outcome-roots">
          <p className="font-medium text-xs">Per workspace root</p>
          {rootOutcomes.map((root) => (
            <p
              className="text-muted-foreground text-xs"
              data-testid={`rewind-outcome-root-${root.rootId}`}
              key={root.rootId}
            >
              <span className="font-medium text-foreground">{root.rootLabel ?? root.rootId}</span>
              {root.rootPath === null ? (
                <span className="text-amber-700 dark:text-amber-300">
                  {' '}
                  (not connected — nothing could be written)
                </span>
              ) : null}
              <span>
                {' '}
                — {root.reverted} of {root.attempted} restored
              </span>
              {root.conflicts > 0 ? <span> · {root.conflicts} conflicting</span> : null}
              {root.failed > 0 ? <span> · {root.failed} not restored</span> : null}
            </p>
          ))}
        </div>
      ) : null}

      {unreverted.length > 0 ? (
        <div className="flex flex-col gap-0.5" data-testid="rewind-outcome-unreverted">
          <p className="font-medium text-xs">Not restored</p>
          {unreverted.map((outcome) => (
            <p className="text-muted-foreground text-xs" key={outcome.checkpointId}>
              <span className="font-mono text-foreground">{outcome.path}</span>
              <span> — {outcome.message ?? outcome.code}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
