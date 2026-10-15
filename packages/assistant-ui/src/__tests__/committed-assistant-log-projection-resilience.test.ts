// @vitest-environment node
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
  it('a recovered stall shows its attempt rows, its one provider warning, and only the recovered text', () => {
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
      // The completed run's terminal event, as the legacy stream ends a run.
      {
        detail: undefined,
        kind: 'run.finished',
        label: 'Assistant run completed',
        status: 'completed',
      },
    ]);
    const texts = message.content.flatMap((part) =>
      part.type === 'text' ? [{ status: part.status, text: part.text }] : []
    );
    // The stalled attempt's partial was live telemetry and was replaced, as in
    // legacy; the recovered step's committed text is the transcript.
    expect(texts).toEqual([{ status: { type: 'complete' }, text: 'Recovered answer.' }]);
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

  it('an overflow recovery shows its compaction card and the attempt that continued after it', () => {
    const threadId = rows[0]?.threadId ?? '';
    const runId = runIds[1] ?? '';
    const last = rows.findIndex(
      ({ event }) => event['type'] === 'run.started' && event['runId'] === runId
    );
    const projection = new CommittedAssistantLogProjection({
      identifyRun: (row) => ({
        assistantMessageId: String(row.event['runId']),
        createdAt: new Date('2026-10-08T12:00:00.000Z'),
        parentMessageId: null,
      }),
      threadId,
    });
    projection.acceptCommitted(rows.slice(0, last + 1));
    const seq = rows[last]?.seq ?? 0;
    const summary =
      'Deterministic fallback: dropped 1 earlier turns (2 messages) after a provider context-overflow error; no summarization model ran.';
    // The exact rows the host commits when an overflow is recovered by compaction.
    projection.acceptCommitted([
      {
        event: {
          compactedRunIds: [runIds[0]],
          kind: 'deterministic',
          reason: 'context-overflow',
          runId,
          summary,
          type: 'context.compacted',
        },
        seq: seq + 1,
        threadId,
      },
      {
        event: {
          attempt: 1,
          detail: "This model's maximum context length was exceeded.",
          maxAttempts: 2,
          reason: 'context-overflow',
          recovered: true,
          runId,
          type: 'run.attempt',
        },
        seq: seq + 2,
        threadId,
      },
    ]);
    const message = projection
      .getSnapshot()
      .repository.messages.find(({ message: item }) => item.id === runId)?.message;
    expect(message?.content.slice(0, 1)).toEqual([
      {
        data: { kind: 'deterministic', summary },
        name: 'brainstrike.context-compacted',
        type: 'data',
      },
    ]);
    expect(runEvents(message?.content ?? []).map(({ kind }) => kind)).toEqual([
      'run.stalled',
      'run.resumed',
    ]);
  });
});
