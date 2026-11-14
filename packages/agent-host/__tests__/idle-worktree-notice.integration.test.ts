/**
 * ADR-0034 decision 7: when the platform's idle-worktree cap archives
 * worktrees after a creation for a thread, that thread is told in a committed
 * row its transcript shows with the run that made the worktree, or with its
 * latest run when the person made it between runs. Archive on merge (BST-2504)
 * tells the thread that made a merged worktree, with its latest run.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostIdleWorktreeArchive } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import { rowsUntil, setupChildRunHost, stream, text } from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const ARCHIVED = [
  {
    branch: 'bs/swift-badger',
    name: 'swift-badger',
    snapshotRef: 'refs/brainstrike/worktree-archive/wt-1',
    worktreeId: 'wt-1',
  },
  {
    branch: null,
    name: 'calm-otter',
    snapshotRef: 'refs/brainstrike/worktree-archive/wt-2',
    worktreeId: 'wt-2',
  },
];

/** A host whose platform reports the cap's archives the test emits. */
async function capHost() {
  const listeners = new Set<(archive: HostIdleWorktreeArchive) => void>();
  // The archive the cap still has in flight when the host starts to close; none by default.
  const inFlight = { settle: async (): Promise<void> => undefined };
  // Runs once an opening host's thread list answers, as the platform's pass after opening reads
  // the threads before it archives anything; none by default.
  const opening: { listed?: () => void } = {};
  const model = new MockLanguageModelV4({ doStream: async () => stream(text('Done.')) });
  const harness = await setupChildRunHost(model, cleanup, {
    attachThreadReads: (reads) => {
      const listed = opening.listed;
      if (listed) {
        void reads.listThreads().then(listed);
      }
    },
    idleWorktreeArchives: {
      afterThreadDeleted: async () => undefined,
      settle: async () => {
        await inFlight.settle();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  const archive = (report: HostIdleWorktreeArchive): void => {
    for (const listener of listeners) {
      listener(report);
    }
  };
  return { archive, harness, inFlight, listeners, opening };
}

const archivedRow = (row: HostLogRow) => row.event.type === 'worktrees.archived';

/** The cap's archive of `ARCHIVED` for a thread, after a creation by `runId` when set. */
const idleCap = (
  address: Pick<HostIdleWorktreeArchive, 'runId' | 'threadId'>
): HostIdleWorktreeArchive => ({ limit: 15, reason: 'idle-cap', worktrees: ARCHIVED, ...address });

test('tells the thread a run made the worktree for, with that run', async () => {
  const { archive, harness } = await capHost();
  const first = await harness.start('Make a worktree.');
  await harness.core().idle(harness.threadId);
  await harness.start('Carry on.');
  await harness.core().idle(harness.threadId);

  archive(idleCap({ runId: first, threadId: harness.threadId }));

  const rows = await rowsUntil(harness, harness.threadId, archivedRow);
  expect(rows.filter(archivedRow).map(({ event }) => event)).toEqual([
    {
      limit: 15,
      reason: 'idle-cap',
      runId: first,
      type: 'worktrees.archived',
      worktrees: ARCHIVED,
    },
  ]);
});

test("tells the thread the person made the worktree in, with the thread's latest run", async () => {
  const { archive, harness } = await capHost();
  await harness.start('Read the notes.');
  await harness.core().idle(harness.threadId);
  const latest = await harness.start('Then summarise them.');
  await harness.core().idle(harness.threadId);

  archive(idleCap({ threadId: harness.threadId }));

  const rows = await rowsUntil(harness, harness.threadId, archivedRow);
  expect(rows.filter(archivedRow).map(({ event }) => event)).toEqual([
    {
      limit: 15,
      reason: 'idle-cap',
      runId: latest,
      type: 'worktrees.archived',
      worktrees: ARCHIVED,
    },
  ]);
});

test('tells the thread that made a merged worktree, with its latest run', async () => {
  const { archive, harness } = await capHost();
  await harness.start('Make a worktree and fix the bug there.');
  await harness.core().idle(harness.threadId);
  const latest = await harness.start('Thanks.');
  await harness.core().idle(harness.threadId);
  const merged = [
    {
      branch: 'bs/swift-badger',
      name: 'swift-badger',
      snapshotRef: 'refs/brainstrike/worktree-archive/wt-1',
      worktreeId: 'wt-1',
    },
  ];

  archive({
    defaultBranch: 'origin/main',
    reason: 'merged',
    threadId: harness.threadId,
    worktrees: merged,
  });

  const rows = await rowsUntil(harness, harness.threadId, archivedRow);
  expect(rows.filter(archivedRow).map(({ event }) => event)).toEqual([
    {
      defaultBranch: 'origin/main',
      reason: 'merged',
      runId: latest,
      type: 'worktrees.archived',
      worktrees: merged,
    },
  ]);
});

// The platform's pass after the host opens reads Core's thread list before it can archive, and
// Core listens for archives before that list answers, so the pass's notice is never dropped.
test('tells a thread of an archive reported as soon as a reopened host lists its threads', async () => {
  const { archive, harness, opening } = await capHost();
  await harness.start('Make a worktree and fix the bug there.');
  await harness.core().idle(harness.threadId);
  const latest = await harness.start('Thanks.');
  await harness.core().idle(harness.threadId);
  const merged = [
    {
      branch: 'bs/swift-badger',
      name: 'swift-badger',
      snapshotRef: 'refs/brainstrike/worktree-archive/wt-1',
      worktreeId: 'wt-1',
    },
  ];
  opening.listed = () =>
    archive({
      defaultBranch: 'origin/main',
      reason: 'merged',
      threadId: harness.threadId,
      worktrees: merged,
    });

  await harness.crash();

  const rows = await rowsUntil(harness, harness.threadId, archivedRow);
  expect(rows.filter(archivedRow).map(({ event }) => event)).toEqual([
    {
      defaultBranch: 'origin/main',
      reason: 'merged',
      runId: latest,
      type: 'worktrees.archived',
      worktrees: merged,
    },
  ]);
});

test('stops listening when the host closes', async () => {
  const { harness, listeners } = await capHost();
  expect(listeners.size).toBe(1);

  await harness.core().close();

  expect(listeners.size).toBe(0);
});

// The cap finishes the archive it has in flight before the host closes, and the thread is told.
test('tells the thread of an archive that finishes as the host starts to close', async () => {
  const { archive, harness, inFlight } = await capHost();
  const run = await harness.start('Make a worktree.');
  await harness.core().idle(harness.threadId);
  inFlight.settle = async () => {
    archive(idleCap({ runId: run, threadId: harness.threadId }));
  };

  await harness.core().close();

  // Read from the store: the closed host serves no reads.
  const rows = await harness.core().store.read(harness.threadId);
  expect(
    rows.map(({ event }) => event).filter(({ type }) => type === 'worktrees.archived')
  ).toEqual([
    expect.objectContaining({
      limit: 15,
      reason: 'idle-cap',
      runId: run,
      type: 'worktrees.archived',
      worktrees: ARCHIVED,
    }),
  ]);
});
