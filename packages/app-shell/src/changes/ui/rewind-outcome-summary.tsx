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
import type { ReactElement } from 'react';
import type { RewindConversationEffect, RewindOutcomeModel } from '../rewind-port';

/** What the rewind did to the conversation, in the owner's own terms. */
export function rewindConversationOutcome(effect: RewindConversationEffect): string {
  if (effect.kind === 'hidden') {
    return `${effect.messages} message${effect.messages === 1 ? '' : 's'} hidden.`;
  }
  return `${effect.turns} turn${effect.turns === 1 ? '' : 's'} left this conversation; switch back to ${effect.turns === 1 ? 'it' : 'them'} with the branch picker.`;
}

export function RewindOutcomeSummary({
  outcome,
}: {
  readonly outcome: RewindOutcomeModel;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3" data-testid="rewind-outcome-summary">
      <p className="text-sm" data-testid="rewind-outcome-messages">
        {rewindConversationOutcome(outcome.conversation)}
      </p>

      {outcome.roots.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="rewind-outcome-roots">
          <p className="font-medium text-xs">Per workspace root</p>
          {outcome.roots.map((root) => (
            <p
              className="text-muted-foreground text-xs"
              data-testid={`rewind-outcome-root-${root.rootId}`}
              key={root.rootId}
            >
              <span className="font-medium text-foreground">{root.label ?? root.rootId}</span>
              {root.rootPath === null ? (
                <span className="text-warning"> (not connected — nothing could be written)</span>
              ) : null}
              <span>
                {' '}
                — {root.restored} of {root.attempted} restored
              </span>
              {root.conflicts > 0 ? <span> · {root.conflicts} conflicting</span> : null}
              {root.failed > 0 ? <span> · {root.failed} not restored</span> : null}
            </p>
          ))}
        </div>
      ) : null}

      {outcome.notRestored.length > 0 ? (
        <div className="flex flex-col gap-0.5" data-testid="rewind-outcome-unreverted">
          <p className="font-medium text-xs">Not restored</p>
          {outcome.notRestored.map((file) => (
            <p className="text-muted-foreground text-xs" key={`${file.rootId}\u0000${file.path}`}>
              <span className="font-mono text-foreground">{file.path}</span>
              <span> — {file.message}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
