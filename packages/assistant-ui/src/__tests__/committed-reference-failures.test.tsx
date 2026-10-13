// Recorded real HostCore admission/store rows; only the provider was scripted.
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import { AssistantRunTimeline } from '../assistant-run-timeline';
import { CommittedAssistantLogProjection } from '../committed-assistant-log-projection';
import recording from './fixtures/committed-host-reference-failures.json';

const start = recording.find((row) => row.event.type === 'run.started');
if (!(start && 'runId' in start.event) || typeof start.event.runId !== 'string') {
  throw new Error('Missing recorded run');
}
const runId = start.event.runId;
function project() {
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date(start!.ts),
      parentMessageId: null,
    }),
    threadId: start!.threadId,
  });
  projection.acceptCommitted(recording);
  return projection.getSnapshot().repository.messages.flatMap(({ message }) =>
    message.role === 'assistant'
      ? message.content.flatMap((part) => {
          const event = readAssistantRunEventDataPart(part);
          return event?.kind === 'reference.unavailable' ? [event] : [];
        })
      : []
  );
}
test('recorded missing and dangling references render visible reasons, unchanged on replay', () => {
  const events = project();
  expect(events).toHaveLength(2);
  expect(events.every(isAlwaysVisibleRunEvent)).toBe(true);
  expect(project()).toEqual(events);
  render(
    <TooltipProvider>
      {events.map((event) => (
        <AssistantRunTimeline data={event} key={event.id} />
      ))}
    </TooltipProvider>
  );
  expect(screen.getAllByText('Referenced file could not be attached')).toHaveLength(2);
  expect(screen.getByText('missing.txt: Path "missing.txt" does not exist.')).toBeInTheDocument();
  expect(
    screen.getByText('dangling.txt: Path "dangling.txt" is outside the selected workspace root.')
  ).toBeInTheDocument();
});
