// @vitest-environment node
// ADR-0034 decision 7: the idle worktrees the cap archived after a worktree
// was made for this thread are named in its transcript, with how to get them back.
// BST-2504: so are the worktrees it made whose branches merging into the default
// branch would change nothing.
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

function notices(
  worktrees: readonly Record<string, unknown>[],
  archive: Record<string, unknown> = { limit: 15, reason: 'idle-cap' }
) {
  const rows: readonly CommittedAssistantLogRow[] = [
    { event: { modelId: 'scripted', prompt: 'Fix the build.', runId, type: 'run.started' } },
    { event: { outcome: 'completed', runId, type: 'run.finished' } },
    // Committed after the run ended: the person made a worktree between runs.
    { event: { ...archive, runId, type: 'worktrees.archived', worktrees }, ts: archivedAt },
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
      'This repository had more than 15 worktrees that no thread is using, so the oldest was archived: swift-badger (branch bs/swift-badger). Its uncommitted changes are kept in its archive snapshot (refs/brainstrike/worktree-archive/wt-1), its commits stay on its branch, and only files git ignores, such as installed dependencies, were deleted. To restore it, choose Other worktree… in the composer’s Where this thread works menu, then Restore and use under Archived.',
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
    'This repository had more than 15 worktrees that no thread is using, so the oldest were archived: swift-badger (branch bs/swift-badger), calm-otter (detached). The uncommitted changes of each are kept in its archive snapshot (refs/brainstrike/worktree-archive/wt-1, refs/brainstrike/worktree-archive/wt-2), its commits stay on its branch, and only files git ignores, such as installed dependencies, were deleted. To restore one, choose Other worktree… in the composer’s Where this thread works menu, then Restore and use under Archived.'
  );
});

// A v25 to v29 host committed the cap's archive with no reason.
it('shows an archive committed with no reason as the idle cap’s', () => {
  expect(notices([BADGER], { limit: 15 })).toEqual(notices([BADGER]));
});

const MERGED = { defaultBranch: 'origin/main', reason: 'merged' };

// BST-2518: not "adds nothing main doesn't have", which a merge main then reverted makes untrue,
// and nothing on uncommitted changes, which a worktree archived on merge never has.
it('says merging its branch would change nothing, what was kept and deleted, and how to restore it', () => {
  const [notice] = notices([BADGER], MERGED);

  expect(notice).toMatchObject({
    detail:
      'Merging the branch bs/swift-badger into origin/main would change nothing, so its worktree swift-badger was archived. Its commits stay on its branch and in its archive snapshot (refs/brainstrike/worktree-archive/wt-1), and only files git ignores, such as installed dependencies, were deleted. To restore it, choose Other worktree… in the composer’s Where this thread works menu, then Restore and use under Archived.',
    label: 'Archived worktree swift-badger: merging its branch would change nothing',
    metadata: { defaultBranch: 'origin/main', reason: 'merged', worktrees: [BADGER] },
    runId,
    status: 'info',
    timestamp: new Date(archivedAt).toISOString(),
  });
  expect(isAlwaysVisibleRunEvent(notice)).toBe(true);
});

it('names each worktree with its branch when merging several branches would change nothing', () => {
  const [notice] = notices(
    [
      BADGER,
      {
        branch: 'bs/calm-otter',
        name: 'calm-otter',
        snapshotRef: 'refs/brainstrike/worktree-archive/wt-2',
        worktreeId: 'wt-2',
      },
    ],
    MERGED
  );

  expect(notice?.label).toBe('Archived 2 worktrees: merging their branches would change nothing');
  expect(notice?.detail).toBe(
    'Merging the branches of these worktrees into origin/main would change nothing, so they were archived: swift-badger (branch bs/swift-badger), calm-otter (branch bs/calm-otter). The commits of each stay on its branch and in its archive snapshot (refs/brainstrike/worktree-archive/wt-1, refs/brainstrike/worktree-archive/wt-2), and only files git ignores, such as installed dependencies, were deleted. To restore one, choose Other worktree… in the composer’s Where this thread works menu, then Restore and use under Archived.'
  );
});

it('refuses an archive notice with a reason it does not know', () => {
  expect(() => notices([BADGER], { limit: 15, reason: 'tidied' })).toThrow(
    'Committed worktree archive has an unsupported reason.'
  );
});

it('refuses a notice that names no worktree rather than showing an empty one', () => {
  expect(() => notices([])).toThrow('Committed worktree archive names no worktrees.');
});
