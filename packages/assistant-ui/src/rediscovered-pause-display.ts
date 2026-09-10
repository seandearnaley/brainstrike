/**
 * Pure display helpers for rediscovered pauses — split from
 * `rediscovered-pause-lines.tsx` so the component file exports only
 * components (react-refresh `only-export-components`; Fast Refresh cannot
 * preserve state through mixed-export files).
 */

import {
  type DelegatedToolDecisionState,
  hasValidDelegatedDecisionState,
  isDelegatedToolDecisionState,
} from '@brainstrike/assistant-contract';

export type RediscoveredPauseDisplay =
  | {
      readonly decisionState: DelegatedToolDecisionState | 'invalid';
      readonly stale?: never;
      readonly suspendedAt?: never;
    }
  | {
      readonly decisionState?: never;
      readonly stale: boolean;
      readonly suspendedAt: string;
    };

export const DELEGATED_DECISION_STATUS_LABELS = {
  claimed: 'Decision in progress',
  consumed: 'Decision already submitted',
  interrupted: 'Decision interrupted',
  invalid: 'Decision status unavailable',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** The rediscovery fields off a data-part payload, or null for a live pause. */
export function readRediscoveredPauseDisplay(data: unknown): RediscoveredPauseDisplay | null {
  if (!isRecord(data)) {
    return null;
  }
  if ('decisionState' in data) {
    const state = data['decisionState'];
    return {
      decisionState:
        hasValidDelegatedDecisionState(data) && isDelegatedToolDecisionState(state)
          ? state
          : 'invalid',
    };
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
