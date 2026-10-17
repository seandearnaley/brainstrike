import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
// Real-bin recordings: a run paused on its question (no `run.finished`), and
// two runs that both finished.
import paused from '@brainstrike/test-utils/fixtures/committed-host-hooks-skipped.json';
import finished from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { CommittedHostCheckpoints } from '../renderer/committed-host-checkpoints';

function checkpoints(recording: unknown) {
  const rows: readonly HostLogRow[] = Schema.decodeUnknownSync(
    Schema.mutable(Schema.Array(HostLogRowSchema)),
    { errors: 'all', onExcessProperty: 'error' }
  )(recording);
  const snapshot = {
    connected: true,
    error: undefined,
    isLoading: false,
    replayedThrough: rows.at(-1)?.seq ?? 0,
    rows,
  };
  return new CommittedHostCheckpoints(
    {
      request: async () => {
        throw new Error('Reading the undo context sends no request');
      },
    },
    { getSnapshot: () => snapshot, subscribe: () => () => undefined },
    rows[0]?.threadId ?? ''
  ).getSnapshot();
}

test('Revert is refused, with its reason, while the thread has a run that has not finished', () => {
  expect(checkpoints(paused).revertRefusal).toBe(
    'Edits can be reverted once the current run finishes.'
  );
  expect(checkpoints(finished).revertRefusal).toBeNull();
});
