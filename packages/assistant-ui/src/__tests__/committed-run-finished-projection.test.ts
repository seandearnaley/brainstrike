// A completed host run's final leg carries the terminal `run.finished` event the
// legacy stream emits, which the run's verdict and Changes review controls read;
// a failed run carries none. Recorded HostCore runs, one completed, one failed.

import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import attemptsRecording from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json';
import { expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';
import { selectFinishedRunId } from '../run-verdict-control';

const rows = attemptsRecording as readonly CommittedAssistantLogRow[];
const outcomeOf = new Map(
  rows.flatMap(({ event }) =>
    event['type'] === 'run.finished' ? [[String(event['runId']), String(event['outcome'])]] : []
  )
);
const runWith = (outcome: string): string => {
  const runId = [...outcomeOf].find(([, value]) => value === outcome)?.[0];
  if (!runId) {
    throw new Error(`The recording has no ${outcome} run.`);
  }
  return runId;
};

function project(projection: CommittedAssistantLogProjection) {
  return (runId: string): readonly unknown[] => {
    const message = projection
      .getSnapshot()
      .repository.messages.find(({ message: item }) => item.id === runId)?.message;
    if (message?.role !== 'assistant') {
      throw new Error('The recorded run has no assistant message.');
    }
    return message.content;
  };
}

const finishedEvents = (content: readonly unknown[]) =>
  content.flatMap((part) => {
    const event = readAssistantRunEventDataPart(part);
    return event?.kind === 'run.finished' ? [event] : [];
  });

it('marks only a completed run’s final leg with run.finished, once, for its verdict and review', () => {
  const projection = new CommittedAssistantLogProjection({
    // Test-owned resolver, as in the projection suite: no production alias.
    identifyRun: (row) => ({
      assistantMessageId: String(row.event['runId']),
      createdAt: new Date('2026-10-08T12:00:00.000Z'),
      parentMessageId: null,
    }),
    threadId: rows[0]?.threadId ?? '',
  });
  projection.acceptCommitted(rows);
  const content = project(projection);
  const completed = runWith('completed');
  const failed = runWith('failed');

  expect(selectFinishedRunId(content(completed))).toBe(completed);
  expect(finishedEvents(content(completed))).toEqual([
    expect.objectContaining({
      kind: 'run.finished',
      label: 'Assistant run completed',
      runId: completed,
      status: 'completed',
    }),
  ]);
  // A failed run is labelled by its own terminal status, never a verdict prompt.
  expect(selectFinishedRunId(content(failed))).toBeNull();

  // Replaying the committed rows publishes no second terminal event.
  projection.acceptCommitted(rows);
  expect(finishedEvents(content(completed))).toHaveLength(1);
});
