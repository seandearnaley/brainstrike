// Actual HostCore + native StateStore capture (record-attempt-log.mjs): run 1's
// first attempt stalls after partial text and recovers; run 2's stall after
// streamed tool input is refused. Each provider call reports a warning.
import recording from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json' with {
  type: 'json',
};
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { hostRunExitError } from '../src/cli-session.js';
import { HostLogRowSchema } from '../src/protocol.js';
import { foldHostRuns, HostRunNotices } from '../src/thread-view.js';

const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
  errors: 'all',
  onExcessProperty: 'error',
})(recording);
const stalled = 'The model stream stalled after 400ms without output.';
const warning =
  'Provider ignored an unsupported setting: temperature: temperature is not supported for reasoning models';

test('the CLI reads each provider warning once per run and every attempt record', () => {
  const notices = new HostRunNotices();
  expect(rows.flatMap((row) => notices.read(row))).toEqual([
    warning,
    `Model stream stalled: ${stalled} Attempt 1 of 2.`,
    'Continuing after a stall: Attempt 2 of 2 starts again from the committed conversation.',
    warning,
    `Model stream stalled: ${stalled} Attempt 1 of 2. Not retried: the step had started a tool call, which must not run twice.`,
  ]);
});

test('a failed run exits with its committed detail', () => {
  const [recovered, refused] = foldHostRuns(rows);
  if (!(recovered && refused)) {
    throw new Error('The recording has two runs');
  }
  expect(recovered).toMatchObject({ status: 'completed' });
  expect(hostRunExitError(recovered)).toBeUndefined();
  expect(refused).toMatchObject({ detail: stalled, status: 'failed' });
  expect(hostRunExitError(refused)).toMatchObject({
    exitCode: 1,
    message: `Run failed: ${stalled}`,
  });
});
