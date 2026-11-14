import approved from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import granted from '@brainstrike/test-utils/fixtures/committed-host-granted-run.json' with {
  type: 'json',
};
import { MessageList } from '@mastra/core/agent';
import { Schema } from 'effect';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { committedRowAddress } from '../src/committed-identities.js';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.js';

function decodeRows(recorded: unknown): HostLogRow[] {
  return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
    errors: 'all',
    onExcessProperty: 'error',
  })(recorded);
}

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
  const rows = decodeRows(granted);
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

/**
 * A result the host commits after its call's row (here, once the user has
 * approved the call) has no call of its own to convert with: it borrows the
 * earlier segment that holds the call.
 */
test('a result committed in a later row than its call converts with that call', () => {
  const rows = decodeRows(approved);
  const result = rows.find(
    (row) =>
      row.event.type === 'model.messages' &&
      JSON.stringify(row.event.messages).includes('"tool-result"')
  );
  if (!result) {
    throw new Error('The recorded run commits no result in a row of its own');
  }
  const segment = committedMemoryTranscript(rows, 'recorded-resource').find(
    (message) => message.id === committedRowAddress(result)
  );
  expect(segment?.content.parts).toContainEqual(
    expect.objectContaining({
      toolInvocation: expect.objectContaining({
        args: { text: 'written by permitted host tool' },
        result: expect.anything(),
        state: 'result',
        toolCallId: 'recorded-call-1',
        toolName: 'write_file',
      }),
      type: 'tool-invocation',
    })
  );
});

/** A run of `steps` tool steps, each committing its call with its result, after the recorded start. */
function longRun(steps: number): HostLogRow[] {
  const recorded = decodeRows(approved);
  const started = recorded.find((row) => row.event.type === 'run.started');
  if (started?.event.type !== 'run.started' || started.ts === undefined) {
    throw new Error('The recorded run has no committed start');
  }
  const { runId } = started.event;
  const { seq, threadId, ts } = started;
  return decodeRows([
    ...recorded.filter((row) => row.seq <= seq),
    ...Array.from({ length: steps }, (_, step) => ({
      event: {
        messages: [
          {
            content: [
              {
                input: { path: `src/file-${step}.ts` },
                toolCallId: `call-${step}`,
                toolName: 'read_file',
                type: 'tool-call',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                output: { type: 'text', value: `file ${step}\n${'x'.repeat(2000)}` },
                toolCallId: `call-${step}`,
                toolName: 'read_file',
                type: 'tool-result',
              },
            ],
            role: 'tool',
          },
        ],
        model: { modelId: 'mock-model-id', provider: 'mock-provider' },
        runId,
        stepNumber: step,
        type: 'model.step',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      seq: seq + 1 + step,
      threadId,
      ts: ts + 1 + step,
    })),
  ]);
}

/**
 * The messages one conversion hands Mastra's converter (`MessageList.add`),
 * which converts each of them in turn. Counted, not timed, so a loaded
 * machine cannot change the answer (BST-2509).
 */
function convertedMessages(steps: number): number {
  const rows = longRun(steps);
  const add = vi.spyOn(MessageList.prototype, 'add');
  try {
    expect(committedMemoryTranscript(rows, 'recorded-resource')).toHaveLength(steps + 1);
    return add.mock.calls.reduce(
      (count, [messages]) => count + (Array.isArray(messages) ? messages.length : 1),
      0
    );
  } finally {
    add.mockRestore();
  }
}

/**
 * Memory reads the whole transcript several times a step, so the work of one
 * read decides how a long run slows down. Converting each row once handed the
 * converter every earlier segment of its run again: a read converted the
 * square of the run's steps, and a 100-step run spent 26 of its 37 seconds
 * here. A read now converts each row's own messages: eight times the steps
 * convert eight times the messages, not 64 times.
 */
test('converting a run converts messages in proportion to its steps', () => {
  expect(convertedMessages(800)).toBeLessThan(24 * convertedMessages(100));
});
