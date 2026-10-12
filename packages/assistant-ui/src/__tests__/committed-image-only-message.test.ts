import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import { expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const rows: readonly CommittedAssistantLogRow[] = recording;
// A 1x1 PNG, as the composer encodes a pasted image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * BST-1932 (AT-09): the host commits an image sent without text as a
 * run.started with an empty prompt beside its images (agent-host 50e018025).
 * Its user message is the image alone; the rest of the thread still projects.
 */
it('presents an image sent without text as a user message of that image alone', () => {
  const index = rows.findIndex(({ event }) => event['type'] === 'run.started');
  const start = rows[index];
  const runId = start?.event['runId'];
  if (!(start && typeof runId === 'string')) {
    throw new Error('Missing the recorded run.');
  }
  const imageOnly: CommittedAssistantLogRow = {
    ...start,
    event: {
      ...start.event,
      attachments: [{ data: PNG, mediaType: 'image/png', name: 'idle.png', type: 'image' }],
      prompt: '',
    },
  };
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-10-06T08:16:33.838Z'),
      metadata: { custom: { hostRunId: runId } },
      parentMessageId: null,
      userMessageId: 'image-only-prompt',
    }),
    threadId: start.threadId,
  });
  projection.acceptCommitted([...rows.slice(0, index), imageOnly, ...rows.slice(index + 1)]);
  const messages = projection.getSnapshot().repository.messages.map(({ message }) => message);
  const user = messages.find(({ id }) => id === 'image-only-prompt');
  expect(user?.content).toEqual([]);
  expect(user?.attachments).toEqual([
    expect.objectContaining({ contentType: 'image/png', name: 'idle.png', type: 'image' }),
  ]);
  // The answer after it still projects.
  expect(messages.find(({ id }) => id === runId)?.role).toBe('assistant');
});
