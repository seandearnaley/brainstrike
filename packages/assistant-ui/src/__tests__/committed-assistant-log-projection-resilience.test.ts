// Actual HostCore + native StateStore capture (record-attempt-log.mjs): run 1's
// first attempt stalls after partial text and recovers; run 2's stall after
// streamed tool input is refused. Each provider call reports a warning.

import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import attemptsRecording from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json';
import { describe, expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const rows = attemptsRecording as readonly CommittedAssistantLogRow[];
const runIds = rows.flatMap(({ event }) =>
  event['type'] === 'run.started' && typeof event['runId'] === 'string' ? [event['runId']] : []
);

function projected() {
  const threadId = rows[0]?.threadId ?? '';
  const projection = new CommittedAssistantLogProjection({
    // Test-owned resolver, as in the projection suite: no production alias.
    identifyRun: (row) => ({
      assistantMessageId: String(row.event['runId']),
      createdAt: new Date('2026-10-08T12:00:00.000Z'),
      parentMessageId: null,
    }),
    threadId,
  });
  projection.acceptCommitted(rows);
  return (runId: string | undefined) => {
    const message = projection
      .getSnapshot()
      .repository.messages.find(({ message: item }) => item.id === runId)?.message;
    if (message?.role !== 'assistant') {
      throw new Error('The recorded run has no assistant message.');
    }
    return message;
  };
}

function runEvents(content: readonly unknown[]) {
  return content.flatMap((part) => {
    const event = readAssistantRunEventDataPart(part);
    return event
      ? [{ detail: event.detail, kind: event.kind, label: event.label, status: event.status }]
      : [];
  });
}

const warned = {
  detail: 'temperature: temperature is not supported for reasoning models',
  kind: 'provider.request.warned',
  label: 'Provider ignored an unsupported setting',
  status: 'failed',
};

describe('committed host run resilience is visible in the thread', () => {
  it('a recovered stall shows its attempt rows, its one provider warning, and the abandoned text as incomplete', () => {
    const message = projected()(runIds[0]);
    expect(runEvents(message.content)).toEqual([
      warned,
      {
        detail: 'The model stream stalled after 400ms without output. Attempt 1 of 2.',
        kind: 'run.stalled',
        label: 'Model stream stalled',
        status: 'info',
      },
      {
        detail: 'Attempt 2 of 2 starts again from the committed conversation.',
        kind: 'run.resumed',
        label: 'Continuing after a stall',
        status: 'info',
      },
    ]);
    const texts = message.content.flatMap((part) =>
      part.type === 'text' ? [{ status: part.status, text: part.text }] : []
    );
    expect(texts).toEqual([
      { status: { reason: 'other', type: 'incomplete' }, text: 'Partial' },
      { status: { type: 'complete' }, text: 'Recovered answer.' },
    ]);
    expect(message.status).toEqual({ reason: 'stop', type: 'complete' });
  });

  it('a refused attempt says why it was not retried, and the run failure stays visible', () => {
    const message = projected()(runIds[1]);
    expect(runEvents(message.content)).toEqual([
      warned,
      {
        detail:
          'The model stream stalled after 400ms without output. Attempt 1 of 2. Not retried: the step had started a tool call, which must not run twice.',
        kind: 'run.stalled',
        label: 'Model stream stalled',
        status: 'info',
      },
    ]);
    expect(message.status).toEqual({
      error: 'The model stream stalled after 400ms without output.',
      reason: 'error',
      type: 'incomplete',
    });
  });
});
