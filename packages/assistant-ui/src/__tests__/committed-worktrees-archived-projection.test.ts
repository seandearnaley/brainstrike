// @vitest-environment node
// ADR-0034 decision 7: the idle worktrees the cap archived after a worktree
// was made for this thread are named in its transcript, with how to get them back.
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { expect, it } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const threadId = 'thread-1';
const runId = 'run-1';
const createdAt = new Date('2026-11-12T12:00:00.000Z');
const archivedAt = Date.parse('2026-11-12T12:05:00.000Z');

function notices(worktrees: readonly Record<string, unknown>[]) {
  const rows: readonly CommittedAssistantLogRow[] = [
    { event: { modelId: 'scripted', prompt: 'Fix the build.', runId, type: 'run.started' } },
    { event: { outcome: 'completed', runId, type: 'run.finished' } },
    // Committed after the run ended: the person made a worktree between runs.
    { event: { limit: 15, runId, type: 'worktrees.archived', worktrees }, ts: archivedAt },
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
    return event?.kind === 'worktree.archived' ? [event] : [];
  });
}

const BADGER = {
  branch: 'bs/swift-badger',
  name: 'swift-badger',
  snapshotRef: 'refs/brainstrike/worktree-archive/wt-1',
  worktreeId: 'wt-1',
};

it('names the archived worktree, its branch and where its changes are kept, at every detail level', () => {
  const [notice] = notices([BADGER]);

  expect(notice).toMatchObject({
    detail:
      'This repository had more than 15 worktrees that no thread is using, so the oldest was archived: swift-badger (branch bs/swift-badger). Its uncommitted changes are kept in its archive snapshot (refs/brainstrike/worktree-archive/wt-1), its commits stay on its branch, and only files git ignores, such as installed dependencies, were deleted.',
    label: 'Archived idle worktree swift-badger',
    metadata: { limit: 15, worktrees: [BADGER] },
    runId,
    status: 'info',
    // It keeps its own time, after the run it is shown with.
    timestamp: new Date(archivedAt).toISOString(),
  });
  expect(isAlwaysVisibleRunEvent(notice)).toBe(true);
});

it('names each worktree when several were archived, a detached one by its name alone', () => {
  const [notice] = notices([
    BADGER,
    {
      branch: null,
      name: 'calm-otter',
      snapshotRef: 'refs/brainstrike/worktree-archive/wt-2',
      worktreeId: 'wt-2',
    },
  ]);

  expect(notice?.label).toBe('Archived 2 idle worktrees');
  expect(notice?.detail).toBe(
    'This repository had more than 15 worktrees that no thread is using, so the oldest were archived: swift-badger (branch bs/swift-badger), calm-otter (detached). The uncommitted changes of each are kept in its archive snapshot (refs/brainstrike/worktree-archive/wt-1, refs/brainstrike/worktree-archive/wt-2), its commits stay on its branch, and only files git ignores, such as installed dependencies, were deleted.'
  );
});

it('refuses a notice that names no worktree rather than showing an empty one', () => {
  expect(() => notices([])).toThrow('Committed worktree archive names no worktrees.');
});
