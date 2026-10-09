import type { RunAttemptNoticeInput } from '@brainstrike/assistant-contract';
import {
  readShellOutputStreamPart,
  SHELL_OUTPUT_DATA_NAME,
} from '@brainstrike/assistant-contract/shell-output';

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
 * `data` chunk as named, or a command's live output as its tool writer
 * committed it (BST-1932, AT-07). Anything else is not a named data part.
 */
export function committedStreamData(
  chunk: Readonly<Record<string, unknown>>
): { readonly data: unknown; readonly name: string } | undefined {
  const type = chunk['type'];
  if ((type === 'data' || type === 'aui-data') && typeof chunk['name'] === 'string') {
    return { data: chunk['data'], name: chunk['name'] };
  }
  const shellOutput = readShellOutputStreamPart(chunk);
  return shellOutput ? { data: shellOutput, name: SHELL_OUTPUT_DATA_NAME } : undefined;
}
