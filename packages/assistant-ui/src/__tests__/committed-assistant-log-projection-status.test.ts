// Actual HostCore + native StateStore captures. The approval run is Packet B's
// shared public fixture; the question and plan runs are byte-identical copies of the
// desktop fixtures apps/desktop/src/__tests__/fixtures/committed-host-*.json.
import approvalRecording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import { describe, expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';
import planRecording from './fixtures/committed-host-plan.json';
import questionRecording from './fixtures/committed-host-question.json';

function eventIndex(rows: readonly CommittedAssistantLogRow[], type: string): number {
  const index = rows.findIndex(({ event }) => event['type'] === type);
  if (index < 0) {
    throw new Error(`The recording has no ${type} row.`);
  }
  return index;
}

function project(rows: readonly CommittedAssistantLogRow[]) {
  const started = rows[eventIndex(rows, 'run.started')];
  const runId = started?.event['runId'];
  if (!(started && typeof runId === 'string')) {
    throw new Error('The recording has no run identity.');
  }
  const projection = new CommittedAssistantLogProjection({
    // Test-owned resolver, as in the projection suite: no production alias.
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-10-06T08:16:33.838Z'),
      parentMessageId: null,
    }),
    threadId: started.threadId,
  });
  const status = () =>
    projection.getSnapshot().repository.messages.find(({ message }) => message.id === runId)
      ?.message.status;
  return { projection, status };
}

describe('committed run status while a host interaction is pending', () => {
  it.each([
    { kind: 'approval', rows: approvalRecording as readonly CommittedAssistantLogRow[] },
    { kind: 'question', rows: questionRecording as readonly CommittedAssistantLogRow[] },
    { kind: 'plan', rows: planRecording as readonly CommittedAssistantLogRow[] },
  ])(
    'a recorded $kind publishes the vendor requires-action status only until its committed response',
    ({ rows }) => {
      const requested = eventIndex(rows, 'interaction.requested');
      const responded = eventIndex(rows, 'interaction.responded');
      const { projection, status } = project(rows);

      projection.acceptCommitted(rows.slice(0, requested));
      expect(status()).toEqual({ type: 'running' });
      projection.acceptCommitted(rows.slice(requested, requested + 1));
      expect(status()).toEqual({ reason: 'interrupt', type: 'requires-action' });
      // Admission and the SDK's own pause chunks are not the committed response.
      projection.acceptCommitted(rows.slice(requested + 1, responded));
      expect(status()).toEqual({ reason: 'interrupt', type: 'requires-action' });
      projection.acceptCommitted(rows.slice(responded, responded + 1));
      expect(status()).toEqual({ type: 'running' });
      projection.acceptCommitted(rows.slice(responded + 1));
      expect(status()).toEqual({ reason: 'stop', type: 'complete' });
    }
  );
});
