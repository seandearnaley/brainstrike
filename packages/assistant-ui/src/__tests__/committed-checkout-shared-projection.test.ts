// @vitest-environment node
// ADR-0034 Automatic isolation: a thread that was not moved to a worktree,
// though another thread is editing the same folder, says so in its transcript.
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { expect, it } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const threadId = 'thread-1';
const runId = 'run-1';
const createdAt = new Date('2026-11-11T12:00:00.000Z');

function notices(reason: string) {
  const rows: readonly CommittedAssistantLogRow[] = [
    { event: { modelId: 'scripted', prompt: 'Write b2.txt.', runId, type: 'run.started' } },
    {
      event: {
        reason,
        root: { displayName: 'beaker', rootId: 'local-root' },
        runId,
        toolCallId: 'call-1',
        type: 'checkout.shared',
      },
    },
    { event: { outcome: 'completed', runId, type: 'run.finished' } },
  ].map((row, index) => ({ ...row, seq: index + 1, threadId }));
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt,
      parentMessageId: null,
      userMessageId: 'prompt-1',
    }),
    threadId,
  });
  const message = projection
    .acceptCommitted(rows)
    .repository.messages.find(({ message: item }) => item.id === runId)?.message;
  if (message?.role !== 'assistant') {
    throw new Error('Missing the projected answer.');
  }
  return message.content.flatMap((part) => {
    const event = readAssistantRunEventDataPart(part);
    return event?.kind === 'checkout.shared' ? [event] : [];
  });
}

it('shows a thread sharing its folder with another writer as an always-visible notice', () => {
  const [notice] = notices('own-uncommitted-edits');

  expect(notice).toMatchObject({
    detail:
      'Another thread is editing beaker too. This thread stayed here because it has uncommitted edits of its own in this folder.',
    label: 'Sharing beaker with another thread',
    metadata: { reason: 'own-uncommitted-edits', rootId: 'local-root' },
    runId,
    status: 'info',
  });
  expect(isAlwaysVisibleRunEvent(notice)).toBe(true);
});

it('says when the thread stayed because its workers are still working there', () => {
  expect(notices('workers-running')[0]?.detail).toBe(
    'Another thread is editing beaker too. This thread stayed here because its workers are still working in this folder.'
  );
});

it('says when the thread stayed because the folder is not a git repository', () => {
  expect(notices('not-a-repository')[0]?.detail).toBe(
    'Another thread is editing beaker too. This thread stayed here because this folder is not a git repository, so it has no worktrees.'
  );
});

it('says when the thread stayed because the repository has no commit yet', () => {
  expect(notices('no-commit-yet')[0]?.detail).toBe(
    'Another thread is editing beaker too. This thread stayed here because this repository has no commit yet, so a worktree has nothing to start from.'
  );
});

it('says when the thread stayed because the folder is inside a repository, below its top folder', () => {
  expect(notices('inside-a-repository')[0]?.detail).toBe(
    'Another thread is editing beaker too. This thread stayed here because this folder is inside a git repository and is not its top folder, so a worktree cannot take its place.'
  );
});

it('says when the thread stayed because the folder is one of its other folders', () => {
  expect(notices('another-folder')[0]?.detail).toBe(
    'Another thread is editing beaker too. This thread stayed here because this is not the folder it works in, and only that folder can become its worktree.'
  );
});

it('refuses a reason it does not know rather than showing a wrong one', () => {
  expect(() => notices('because')).toThrow('Committed shared checkout has an unsupported reason.');
});
