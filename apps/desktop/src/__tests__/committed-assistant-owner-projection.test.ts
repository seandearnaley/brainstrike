import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { CommittedThreadView } from '@brainstrike/agent-host/thread-view';
import { CommittedAssistantLogProjection } from '@brainstrike/assistant-ui';
// Actual HostCore, native SQLite and public SDK approved-run capture, unchanged.
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import { expect, it } from 'vitest';

const rows = recording.map((row) => HostLogRowSchema.parse(row));
const start = rows.find(({ event }) => event.type === 'run.started');
const accepted = rows.find(
  ({ event }) => event.type === 'command.accepted' && event.method === 'run/start'
);
if (start?.event.type !== 'run.started' || accepted?.event.type !== 'command.accepted') {
  throw new Error('Missing committed recording identities.');
}
const threadId = start.threadId;
const runId = start.event.runId;
const promptId = accepted.event.commandId;
function projector(): CommittedAssistantLogProjection {
  return new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-10-06T08:16:33.838Z'),
      metadata: { custom: { hostRunId: runId } },
      parentMessageId: null,
      userMessageId: promptId,
    }),
    threadId,
  });
}

it('reuses the public owner gap fold and equals a fresh fold after reconnect overlap', () => {
  const committedRows = recording.map((row) => HostLogRowSchema.parse(row));
  const owner = new CommittedThreadView(threadId);
  const projection = projector();
  let publications = 0;
  owner.subscribe(() => {
    projection.acceptCommitted(owner.getSnapshot());
    publications += 1;
  });
  owner.accept(committedRows.slice(8));
  expect(publications).toBe(0);
  owner.accept(committedRows.slice(0, 8));
  expect(publications).toBe(1);
  const prior = projection.getSnapshot();
  owner.accept(structuredClone(committedRows));
  expect(publications).toBe(1);
  expect(projection.getSnapshot()).toBe(prior);
  const freshOwner = new CommittedThreadView(threadId);
  freshOwner.accept(committedRows);
  const fresh = projector();
  fresh.acceptCommitted(freshOwner.getSnapshot());
  expect(projection.getSnapshot()).toEqual(fresh.getSnapshot());
});
