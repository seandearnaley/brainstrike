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
import { Predicate } from 'effect';
import { formatRelativeTime } from './relative-time.ts';

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
  cancelled: 'Turn cancelled',
  claimed: 'Decision in progress',
  consumed: 'Decision already submitted',
  interrupted: 'Decision interrupted',
  invalid: 'Decision status unavailable',
} as const;

/** The rediscovery fields off a data-part payload, or null for a live pause. */
export function readRediscoveredPauseDisplay(data: unknown): RediscoveredPauseDisplay | null {
  if (!Predicate.isObject(data)) {
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

/** "Pending since <relative>" text; null when the timestamp is unparseable. */
export function formatPendingSince(suspendedAt: string, now: number): string | null {
  const suspendedMs = Date.parse(suspendedAt);
  if (Number.isNaN(suspendedMs)) {
    return null;
  }
  return formatRelativeTime(suspendedMs, now);
}
