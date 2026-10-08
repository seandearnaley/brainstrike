import { expect, test } from 'vitest';
import { z } from 'zod';
import { hostInputSettlement } from '../src/cli-session.js';
import { HostLogRowSchema } from '../src/protocol.js';
import { CommittedThreadView, foldHostRuns } from '../src/thread-view.js';
import recording from './fixtures/approved-run-log.json' with { type: 'json' };

const rows = z.array(HostLogRowSchema).parse(recording);
const threadId = rows[0]?.threadId;
if (!threadId) {
  throw new Error('The runtime recording has no thread');
}

test('recorded approved host run folds into completed output with no open approval', () => {
  const [run] = foldHostRuns(rows);
  const text = rows
    .flatMap(({ event }) => {
      if (
        event.type !== 'stream.chunk' ||
        !event.chunk ||
        typeof event.chunk !== 'object' ||
        Array.isArray(event.chunk)
      ) {
        return [];
      }
      return event.chunk['type'] === 'text-delta' ? [event.chunk['text']] : [];
    })
    .join('');
  expect(run?.status).toBe('completed');
  expect(run?.text).toBe(text);
  expect(run?.approvals).toEqual([]);
  expect(run?.results).toEqual(
    rows.map((row) => row.event).filter((item) => item.type === 'effect.finished')
  );
});

test('recorded pause stays visible until its committed response arrives', () => {
  const response = rows.findIndex((row) => row.event.type === 'interaction.responded');
  const requested = rows.find((row) => row.event.type === 'interaction.requested')?.event;
  expect(foldHostRuns(rows.slice(0, response))[0]?.approvals).toEqual([requested]);
  expect(foldHostRuns(rows.slice(0, response + 1))[0]?.approvals).toEqual([]);
});

test('reordered replay/live overlap displays only a contiguous committed prefix once', () => {
  const view = new CommittedThreadView(threadId);
  let publications = 0;
  view.subscribe(() => {
    publications += 1;
  });
  view.accept(rows.slice(1).toReversed());
  expect(view.getSnapshot()).toEqual([]);
  view.accept(rows);
  expect(view.getSnapshot()).toEqual(rows);
  view.accept(rows);
  expect(view.getSnapshot()).toEqual(rows);
  expect(publications).toBe(1);
});

test('another thread cannot enter the selected committed view', () => {
  const view = new CommittedThreadView(threadId);
  view.accept(rows.map((row) => ({ ...row, threadId: 'other-recording' })));
  expect(view.getSnapshot()).toEqual([]);
});

test('committed MCP server input stays answerable until its committed retirement', () => {
  const run = rows.find((row) => row.event.type === 'effect.started')?.event;
  const last = rows.at(-1)?.seq ?? 0;
  if (run?.type !== 'effect.started') {
    throw new Error('The runtime recording has no host tool call');
  }
  const input = { inputId: 'presentation-1', runId: run.runId, toolCallId: run.toolCallId };
  const [requested, retired] = z.array(HostLogRowSchema).parse([
    {
      event: {
        ...input,
        presentation: {
          id: 'presentation-1',
          message: 'Approve the reference task?',
          mode: 'form',
          provenance: {
            caller: { runId: run.runId, threadId, toolCallId: run.toolCallId },
            configuredProtocol: '2026-07-28',
            configuredServerId: 'lab.tasks',
            generation: 1,
            invocationId: 'process-nonce:task:3',
            negotiatedRevision: '2026-07-28',
            operation: { target: 'start_task', type: 'tools/call' },
            requestId: 'approval',
            transport: 'streamable-http',
          },
          requestedSchema: {
            properties: { approved: { type: 'boolean' } },
            required: ['approved'],
            type: 'object',
          },
        },
        type: 'input.requested',
      },
      seq: last + 1,
      threadId,
    },
    {
      event: { ...input, code: 'mcp-elicitation-already-settled', type: 'input.retired' },
      seq: last + 2,
      threadId,
    },
  ]);
  const event = requested?.event;
  if (!(requested && retired) || event?.type !== 'input.requested') {
    throw new Error('The committed input rows did not parse');
  }
  expect(foldHostRuns([...rows, requested])[0]?.inputs).toEqual([event]);
  expect(foldHostRuns([...rows, requested, retired])[0]?.inputs).toEqual([]);
  const settlement = {
    configuredServerId: 'lab.tasks',
    generation: 1,
    id: 'presentation-1',
    requestId: 'approval',
  };
  expect(hostInputSettlement(event, ' accept {"approved":true} ')).toEqual({
    ...settlement,
    action: 'accept',
    content: { approved: true },
  });
  expect(hostInputSettlement(event, 'decline')).toEqual({
    ...settlement,
    action: 'decline',
  });
  for (const [answer, error] of [
    ['accept', 'accept needs the form content as a JSON object.'],
    ['decline now', 'decline takes no content.'],
    ['maybe', 'Enter accept, decline, cancel, or stop.'],
  ] as const) {
    expect(() => hostInputSettlement(event, answer)).toThrow(error);
  }
});
