import type { RunAttemptNoticeInput } from '@brainstrike/assistant-contract';

const ATTEMPT_REASONS = new Set<unknown>([
  'context-overflow',
  'empty-response',
  'provider-error',
  'stalled',
]);
const ATTEMPT_REFUSALS = new Set<unknown>(['budget-exhausted', 'tool-parts', 'committed-output']);

/** A committed host `run.attempt` row, read strictly like every other committed event. */
export function readRunAttempt(event: Readonly<Record<string, unknown>>): RunAttemptNoticeInput {
  const { attempt, detail, maxAttempts, reason, recovered, refusal } = event;
  if (typeof detail !== 'string' || !detail) {
    throw new Error('Committed host event is missing detail.');
  }
  if (
    typeof attempt !== 'number' ||
    typeof maxAttempts !== 'number' ||
    !ATTEMPT_REASONS.has(reason) ||
    typeof recovered !== 'boolean' ||
    (refusal !== undefined && !ATTEMPT_REFUSALS.has(refusal))
  ) {
    throw new Error('Committed run attempt has an unsupported shape.');
  }
  return {
    attempt,
    detail,
    maxAttempts,
    reason: reason as RunAttemptNoticeInput['reason'],
    recovered,
    ...(refusal === undefined
      ? {}
      : { refusal: refusal as NonNullable<RunAttemptNoticeInput['refusal']> }),
  };
}

/**
 * A committed `stream.chunk` the timeline presents as a named data part: a
 * `data` chunk, as named. Anything else is not a named data part. A command's
 * live output is never committed (ADR-0011 amendment), so a shell slice an
 * older log holds presents nothing, as legacy did.
 */
export function committedStreamData(
  chunk: Readonly<Record<string, unknown>>
): { readonly data: unknown; readonly name: string } | undefined {
  const type = chunk['type'];
  if ((type === 'data' || type === 'aui-data') && typeof chunk['name'] === 'string') {
    return { data: chunk['data'], name: chunk['name'] };
  }
  return;
}
