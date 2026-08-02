/**
 * The two additive lines a REDISCOVERED pause renders — "Pending since …" and
 * the stale advisory — shared by the approval notice and (since BST-1084) the
 * suspend notices, so the two rediscovery surfaces cannot drift. A LIVE pause
 * carries neither `suspendedAt` nor `stale` and renders nothing extra.
 * Display-only per the settled D5 ruling: it never disables the controls
 * (surface, never auto-decline / auto-answer).
 */
import { useState } from 'react';
import { formatPendingSince, type RediscoveredPauseDisplay } from './rediscovered-pause-display';

export function RediscoveredPauseLines({ display }: { display: RediscoveredPauseDisplay | null }) {
  // Freeze the reference clock at mount (lazy initializer runs once) so render
  // stays pure — "pending since" is a mount-anchored relative time, it does not
  // need to tick, and this keeps React Compiler able to memoize the component.
  const [renderedAt] = useState(() => Date.now());
  if (!display) {
    return null;
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
        <p className="mt-0.5 text-amber-700 text-xs dark:text-amber-400">
          This has been pending a while — re-running the request may be safer.
        </p>
      ) : null}
    </>
  );
}
