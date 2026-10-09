import type { HookSkipNoticeInput, RunAttemptNoticeInput } from '@brainstrike/assistant-contract';

/**
 * Strict readers of committed host event fields for the log projection: an
 * unsupported shape throws, never degrades to a guess.
 */

export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) {
    throw new Error(`Committed host event is missing ${key}.`);
  }
  return field;
}

const ATTEMPT_REASONS = new Set<unknown>([
  'context-overflow',
  'empty-response',
  'provider-error',
  'stalled',
]);
const ATTEMPT_REFUSALS = new Set<unknown>(['budget-exhausted', 'tool-parts', 'committed-output']);

/** A committed host `run.attempt` row, read strictly like every other committed event. */
export function readRunAttempt(event: Readonly<Record<string, unknown>>): RunAttemptNoticeInput {
  const { attempt, maxAttempts, reason, recovered, refusal } = event;
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
    detail: requiredString(event, 'detail'),
    maxAttempts,
    reason: reason as RunAttemptNoticeInput['reason'],
    recovered,
    ...(refusal === undefined
      ? {}
      : { refusal: refusal as NonNullable<RunAttemptNoticeInput['refusal']> }),
  };
}

const HOOK_SKIP_REASONS = new Set<unknown>([
  'changed',
  'invalid',
  'over-budget',
  'unreadable',
  'untrusted',
]);

/** A committed `hooks.skipped` row's files: at least one, each with a known reason. */
export function readHookSkips(
  event: Readonly<Record<string, unknown>>
): readonly HookSkipNoticeInput[] {
  const files = event['files'];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Committed hooks.skipped names no files.');
  }
  return files.map((entry): HookSkipNoticeInput => {
    const file = record(entry);
    if (!(file && HOOK_SKIP_REASONS.has(file['reason']))) {
      throw new Error('Committed hook skip has an unsupported shape.');
    }
    return {
      detail: requiredString(file, 'detail'),
      path: requiredString(file, 'path'),
      reason: file['reason'] as HookSkipNoticeInput['reason'],
    };
  });
}
