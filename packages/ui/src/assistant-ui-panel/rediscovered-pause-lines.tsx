/**
 * The two additive lines a REDISCOVERED pause renders — "Pending since …" and
 * the stale advisory — shared by the approval notice and (since BST-1084) the
 * suspend notices, so the two rediscovery surfaces cannot drift. A LIVE pause
 * carries neither `suspendedAt` nor `stale` and renders nothing extra.
 * Display-only per the settled D5 ruling: it never disables the controls
 * (surface, never auto-decline / auto-answer).
 */
import { useState } from 'react';

export interface RediscoveredPauseDisplay {
  readonly stale: boolean;
  readonly suspendedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** The rediscovery fields off a data-part payload, or null for a live pause. */
export function readRediscoveredPauseDisplay(data: unknown): RediscoveredPauseDisplay | null {
  if (!isRecord(data)) {
    return null;
  }
  const suspendedAt = data['suspendedAt'];
  const stale = data['stale'];
  if (typeof suspendedAt !== 'string' || typeof stale !== 'boolean') {
    return null;
  }
  return { stale, suspendedAt };
}

const RELATIVE_TIME_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

// Building an Intl formatter is expensive; hoist a single shared instance.
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "Pending since <relative>" text; null when the timestamp is unparseable. */
export function formatPendingSince(suspendedAt: string, now: number): string | null {
  const suspendedMs = Date.parse(suspendedAt);
  if (Number.isNaN(suspendedMs)) {
    return null;
  }
  const elapsedMs = Math.max(0, now - suspendedMs);
  for (const [unit, unitMs] of RELATIVE_TIME_UNITS) {
    if (elapsedMs >= unitMs) {
      return RELATIVE_TIME_FORMATTER.format(-Math.floor(elapsedMs / unitMs), unit);
    }
  }
  return RELATIVE_TIME_FORMATTER.format(-Math.floor(elapsedMs / 1000), 'second');
}

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
