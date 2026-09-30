/**
 * The two additive lines a REDISCOVERED pause renders — "Pending since …" and
 * the stale advisory — shared by the approval notice and (since BST-1084) the
 * suspend notices, so the two rediscovery surfaces cannot drift. A LIVE pause
 * carries neither `suspendedAt` nor `stale` and renders nothing extra.
 * Staleness remains advisory. A durable admission state is different: the
 * original decision cannot be submitted again, and the shared cards lock it.
 */
import { useState } from 'react';
import {
  DELEGATED_DECISION_STATUS_LABELS,
  formatPendingSince,
  type RediscoveredPauseDisplay,
} from './rediscovered-pause-display';

export function RediscoveredPauseLines({ display }: { display: RediscoveredPauseDisplay | null }) {
  // Freeze the reference clock at mount (lazy initializer runs once) so render
  // stays pure — "pending since" is a mount-anchored relative time, it does not
  // need to tick, and this keeps React Compiler able to memoize the component.
  const [renderedAt] = useState(() => Date.now());
  if (!display) {
    return null;
  }
  if (display.decisionState !== undefined) {
    const explanation = {
      cancelled: 'This turn was cancelled. This decision can no longer be submitted.',
      claimed: 'This decision is being processed. Reload to refresh its status.',
      consumed: 'This decision cannot be submitted again. Check the conversation for its outcome.',
      interrupted:
        'Processing stopped and the outcome is unknown. Check the workspace before starting another action.',
      invalid: 'The saved decision status could not be read. Reload to check it before continuing.',
    }[display.decisionState];
    return (
      <p
        className="mt-1 text-warning text-xs"
        data-testid="delegated-decision-recovery-status"
        role="status"
      >
        <span className="font-medium">
          {DELEGATED_DECISION_STATUS_LABELS[display.decisionState]}.
        </span>{' '}
        {explanation}
      </p>
    );
  }
  const pendingSince = formatPendingSince(display.suspendedAt, renderedAt);
  return (
    <>
      {pendingSince ? (
        <p className="mt-0.5 truncate text-muted-foreground text-xs">
          Pending since {pendingSince}
        </p>
      ) : null}
      {display.stale ? (
        <p className="mt-0.5 text-warning text-xs">
          This request has been pending a while — re-running it may be safer.
        </p>
      ) : null}
    </>
  );
}
