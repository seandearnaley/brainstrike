// @vitest-environment node

import { BoundaryFailureError, fault, refusal } from '@brainstrike/assistant-contract';
import { expect, it, vi } from 'vitest';
import type { NativeIndexEvent } from '../native-index-lifecycle';
import { createNativeIndexFailures } from '../native-index-reopen';

const timeout = new BoundaryFailureError(
  fault({ category: 'timeout', code: 'state-index.request-timeout', message: 'Timed out.' })
);

function recorder() {
  const events: NativeIndexEvent[] = [];
  const failures = createNativeIndexFailures({
    delaysMs: [0, 0],
    dispatch: async (event) => {
      events.push(event);
    },
    onError: vi.fn(),
  });
  const reopens = () => events.flatMap((event) => (event.kind === 'reopen' ? [event] : []));
  const scheduled = () =>
    events.flatMap((event) => (event.kind === 'failure' && event.reopen ? [event.reopen] : []));
  return { events, failures, reopens, scheduled };
}

it('re-opens a transient startup failure once per delay in a row, then records it unscheduled', async () => {
  const { events, failures, reopens, scheduled } = recorder();
  for (const generation of [1, 2, 3]) {
    failures.record(generation, timeout, true);
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe(generation < 3 ? 'reopen' : 'failure'));
  }
  expect(scheduled()).toEqual([
    { attempt: 1, attempts: 2 },
    { attempt: 2, attempts: 2 },
  ]);
  expect(reopens()).toEqual([
    { generation: 1, kind: 'reopen' },
    { generation: 2, kind: 'reopen' },
  ]);
});

it('a started generation ends the series, so its next transient failure re-opens again', async () => {
  const { failures, reopens, scheduled } = recorder();
  failures.record(1, timeout, true);
  await vi.waitFor(() => expect(reopens()).toHaveLength(1));
  failures.record(2, timeout, true);
  await vi.waitFor(() => expect(reopens()).toHaveLength(2));
  failures.started();
  failures.record(3, timeout, true);
  await vi.waitFor(() => expect(reopens()).toHaveLength(3));
  expect(scheduled().map(({ attempt }) => attempt)).toEqual([1, 2, 1]);
});

it('never re-opens a failure after startup, a refusal, or one not typed as transient', async () => {
  const { events, failures } = recorder();
  failures.record(1, timeout);
  failures.record(1, new Error('Workspace walk failed.'), true);
  failures.record(
    1,
    new BoundaryFailureError(
      fault({ category: 'internal', code: 'boundary.internal', message: 'Something went wrong.' })
    ),
    true
  );
  // The host's final word on a state index that keeps stopping: its remedy is a person.
  failures.record(
    1,
    new BoundaryFailureError(
      refusal({
        category: 'availability',
        code: 'state-index.retired',
        message: 'The state index stopped 4 times in a row.',
        remedy: 'Restart BrainStrike.',
      })
    ),
    true
  );
  await vi.waitFor(() => expect(events).toHaveLength(4));
  expect(events.every((event) => event.kind === 'failure' && !event.reopen)).toBe(true);
});
