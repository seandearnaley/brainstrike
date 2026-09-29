/**
 * The activity group's phase and every string derived from it: the resting
 * headline, the elapsed/verb meta segments, the step count and the sr-only
 * announcement.
 *
 * Split out of `activity-trace.tsx` (BST-1684) so that file exports only its
 * components — Fast Refresh boundary rule — and so the derivations can be
 * read (and unit-tested) without mounting the trace. Pure functions only: no
 * hooks, no JSX, no React import.
 */
import type { MessageStatus } from '@assistant-ui/react';
import type { ActivitySummary } from './activity-trace-model';

/** The group's own incomplete reason, exactly as the library types it. */
export type TraceIncompleteReason = Extract<MessageStatus, { type: 'incomplete' }>['reason'];

export type TracePhase = 'cancelled' | 'done' | 'failed' | 'running';

export function phaseOf(
  isActive: boolean,
  incompleteReason: TraceIncompleteReason | undefined
): TracePhase {
  if (isActive) {
    return 'running';
  }
  if (incompleteReason === 'cancelled') {
    return 'cancelled';
  }
  return incompleteReason === undefined ? 'done' : 'failed';
}

const PHASE_ANNOUNCEMENT: Record<TracePhase, string> = {
  cancelled: 'Stopped',
  done: 'Finished',
  failed: 'Failed',
  running: 'Working',
};

/** The resting-headline text: verb summary at rest, or the group's own stop/failure state. */
export function headlineFor(phase: TracePhase, restingHeadline: string): string {
  if (phase === 'cancelled') {
    return 'Stopped';
  }
  if (phase === 'failed') {
    return 'Activity failed';
  }
  return restingHeadline;
}

/**
 * The elapsed-meta text next to the headline; omitted entirely for `failed`.
 * There is no separator node between the meta spans (the visual gap is CSS),
 * so each segment carries its own: the done meta reads "· Worked for 12.0s"
 * like "· N steps" and "· N failed" beside it. Cancelled is the exception —
 * it continues its own headline, so it keeps a leading space and reads
 * "Stopped after 4.0s" as one phrase rather than "Stopped · after 4.0s".
 */
export function metaFor(phase: TracePhase, elapsedLabel: string | null): string | null {
  if (!elapsedLabel || phase === 'failed') {
    return null;
  }
  return phase === 'cancelled' ? ` after ${elapsedLabel}` : `· Worked for ${elapsedLabel}`;
}

/**
 * When the group's own status (not a step failure) overrides the headline
 * with `Stopped` / `Activity failed`, the verb summary that would otherwise
 * have been the headline is demoted to a `· <verb summary>` meta segment
 * instead of disappearing — so "Read 2 files, ran a script" is still visible
 * next to "Stopped after 4.0s". Takes the VERB SUMMARY (`summary.verbs`,
 * null when no tool step settled), never `resting`: demoting the latter put
 * its `Worked`/`Thought` placeholder on screen as "Stopped after 4.0s ·
 * Worked · 1 step" for the very groups this rule exists for (review
 * finding 1).
 */
export function verbMetaFor(
  phase: TracePhase,
  verbs: string | null,
  stepCount: number
): string | null {
  return phase !== 'done' && stepCount > 0 ? verbs : null;
}

export function stepLabel(count: number): string {
  return count > 0 ? `${count} ${count === 1 ? 'step' : 'steps'}` : '';
}

const WAITING_LABEL = 'Waiting for approval';

/**
 * True while the run is paused on the USER. The model owns the test
 * (`ActivitySummary.waiting`: a gated step exists and no tool step still
 * runs) — deliberately narrower than the live LABEL, which reads
 * "Waiting for approval" even while a sibling call is still executing.
 * Shared by the sr-only announcement and the elapsed-clock gate so the two
 * cannot drift apart.
 */
export function isWaitingForUser(phase: TracePhase, summary: ActivitySummary): boolean {
  return phase === 'running' && summary.waiting;
}

/** The sr-only status-transition announcement; "Waiting for approval" is the one exception that isn't just the phase's fixed text. */
export function announcementFor(phase: TracePhase, summary: ActivitySummary): string {
  if (isWaitingForUser(phase, summary)) {
    return WAITING_LABEL;
  }
  return PHASE_ANNOUNCEMENT[phase];
}
