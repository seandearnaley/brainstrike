import type { HostRunState } from './core-state.js';
import type { HostEvent } from './protocol.js';
import type { HostRunOutcome } from './run-outcome.js';

export type HostRunAttemptEvent = Extract<HostEvent, { type: 'run.attempt' }>;

/**
 * The legacy attempt policy (ATTEMPTS VS TURNS) over the host's committed log.
 * A stall, a retryable provider error or an empty reply ends the attempt, not
 * the run leg: a fresh SDK loop over the committed branch follows, up to the
 * leg's `maxAttempts`. A step that streamed tool input or a call is never
 * re-run, so no tool effect executes twice. Recovery is never silent: every
 * attempt failure is committed before the next attempt or `run.finished`.
 */
export function hostRunAttemptEvent(
  run: HostRunState,
  outcome: HostRunOutcome,
  attempt: number,
  maxAttempts: number
): HostRunAttemptEvent | undefined {
  const failure = outcome.attemptFailure();
  if (!failure) {
    return;
  }
  const refusal =
    failure.refusal ?? (attempt >= maxAttempts ? ('budget-exhausted' as const) : undefined);
  return {
    attempt,
    detail: failure.detail,
    maxAttempts,
    reason: failure.reason,
    recovered: refusal === undefined,
    runId: run.id,
    type: 'run.attempt',
    ...(refusal ? { refusal } : {}),
    ...(failure.stall ? { stall: failure.stall } : {}),
  };
}
