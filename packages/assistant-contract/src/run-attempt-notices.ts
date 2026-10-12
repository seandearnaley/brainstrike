/**
 * The visible wording of a CLI-first host `run.attempt` row, shared by the
 * desktop thread view and the CLI. The labels match the legacy path's
 * `run.stalled` / `run.resumed` rows so a recovered attempt reads the same.
 */

/** The `run.attempt` fields a notice reads; the host protocol owns the row. */
export interface RunAttemptNoticeInput {
  readonly attempt: number;
  readonly detail: string;
  readonly maxAttempts: number;
  readonly reason: 'stalled' | 'provider-error' | 'empty-response' | 'context-overflow';
  readonly recovered: boolean;
  readonly refusal?: 'budget-exhausted' | 'tool-parts' | 'committed-output' | undefined;
}

export interface RunAttemptNoticeLine {
  readonly detail: string;
  readonly label: string;
}

export interface RunAttemptNotice {
  /** The attempt that ended, and why it was or was not retried. */
  readonly ended: RunAttemptNoticeLine;
  /** Present when a fresh attempt follows. */
  readonly resumed?: RunAttemptNoticeLine;
}

const ENDED_LABELS: Readonly<Record<RunAttemptNoticeInput['reason'], string>> = {
  'context-overflow': 'Provider context overflowed',
  'empty-response': 'Model returned an empty response',
  'provider-error': 'Provider request failed',
  stalled: 'Model stream stalled',
};

const RESUMED_LABELS: Readonly<Record<RunAttemptNoticeInput['reason'], string>> = {
  'context-overflow': 'Continuing after compaction',
  'empty-response': 'Continuing after an empty response',
  'provider-error': 'Continuing after a provider error',
  stalled: 'Continuing after a stall',
};

const REFUSALS: Readonly<Record<NonNullable<RunAttemptNoticeInput['refusal']>, string>> = {
  'budget-exhausted': 'No attempts remain.',
  'committed-output': 'Not retried: the provider had already returned part of this step.',
  'tool-parts': 'Not retried: the step had started a tool call, which must not run twice.',
};

export function describeRunAttempt(input: RunAttemptNoticeInput): RunAttemptNotice {
  const position = `Attempt ${input.attempt} of ${input.maxAttempts}.`;
  const ended: RunAttemptNoticeLine = {
    detail: [input.detail, position, input.refusal ? REFUSALS[input.refusal] : undefined]
      .filter((part): part is string => part !== undefined)
      .join(' '),
    label: ENDED_LABELS[input.reason],
  };
  return input.recovered
    ? {
        ended,
        resumed: {
          detail: `Attempt ${input.attempt + 1} of ${input.maxAttempts} starts again from the committed conversation.`,
          label: RESUMED_LABELS[input.reason],
        },
      }
    : { ended };
}
