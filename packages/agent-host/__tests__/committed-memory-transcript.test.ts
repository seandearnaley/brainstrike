import granted from '@brainstrike/test-utils/fixtures/committed-host-granted-run.json' with {
  type: 'json',
};
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.js';

/** The recorded run's approval requests, by tool call: answered by the SDK itself or by the user. */
function approvalRequests(rows: readonly HostLogRow[]): Map<string, boolean> {
  const requests = new Map<string, boolean>();
  for (const row of rows) {
    if (row.event.type !== 'model.step' && row.event.type !== 'model.messages') {
      continue;
    }
    for (const message of row.event.messages) {
      const parts = z
        .object({ content: z.array(z.record(z.string(), z.unknown())).or(z.string()) })
        .parse(message).content;
      for (const part of typeof parts === 'string' ? [] : parts) {
        if (part['type'] === 'tool-approval-request') {
          requests.set(z.string().parse(part['toolCallId']), part['isAutomatic'] === true);
        }
      }
    }
  }
  return requests;
}

/** Every converted part of one call, across the committed segments that carry it. */
function invocations(rows: readonly HostLogRow[], toolCallId: string): unknown[] {
  return committedMemoryTranscript(rows, 'recorded-resource')
    .flatMap((message) => message.content.parts)
    .filter(
      (part) => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === toolCallId
    );
}

test('a call the policy allowed converts as its result; a user-answered approval keeps its answer', () => {
  const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
    errors: 'all',
    onExcessProperty: 'error',
  })(granted);
  const requests = [...approvalRequests(rows)];
  const allowed = requests.find(([, automatic]) => automatic)?.[0];
  const answered = requests.find(([, automatic]) => !automatic)?.[0];
  if (!(allowed && answered)) {
    throw new Error('The recorded run has no automatic and user-answered approval pair');
  }

  // The allowed call reads as its result, with no approval left to answer.
  expect(invocations(rows, allowed)).toEqual([
    expect.objectContaining({
      toolInvocation: expect.objectContaining({ result: expect.anything(), state: 'result' }),
    }),
  ]);
  expect(invocations(rows, allowed)).not.toContainEqual(
    expect.objectContaining({
      toolInvocation: expect.objectContaining({ approval: expect.anything() }),
    })
  );
  // The user's answer converts as committed.
  expect(invocations(rows, answered)).toContainEqual(
    expect.objectContaining({
      toolInvocation: expect.objectContaining({
        approval: expect.objectContaining({ approved: true }),
      }),
    })
  );
});
