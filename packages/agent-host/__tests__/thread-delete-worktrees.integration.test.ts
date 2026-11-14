/**
 * BST-2505: when a thread is deleted, the platform archives the managed
 * worktrees the thread made that no thread is bound to. Core asks once the
 * deletion has committed, outside its admission queue, so a worktree a stopped
 * or deleted run was still making is in the ledger by then, and the deletion
 * never waits on the archive or fails for it.
 */
import { randomUUID } from 'node:crypto';
import type { StateStore, WorktreeLedgerRow } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import type { HostPlatform, HostThreadReads } from '../src/ports.js';
import {
  blocked,
  childThreads,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** The row the worktree service records for a worktree a run made, naming its thread and run. */
function madeRow(
  threadId: string,
  runId: string,
  name = 'never-entered'
): WorktreeLedgerRow & { baseCommit: string } {
  return {
    archivedAt: null,
    archiveSnapshotRef: null,
    baseCommit: 'c'.repeat(40),
    baseRef: 'main',
    branch: `bs/${name}`,
    createdAt: new Date().toISOString(),
    createdBy: 'agent',
    id: `wt-${name}`,
    path: `/disposable/worktrees/app/${name}`,
    repoCommonDir: '/disposable/app/.git',
    runId,
    setupOutput: null,
    setupReason: null,
    setupStatus: 'none',
    threadId,
  };
}

/** What the platform's pass saw when Core asked it to archive a deleted thread's worktrees. */
interface Pass {
  readonly done: Promise<void>;
  readonly threadId: string;
}

/**
 * A host whose model calls `manageWorktree` create once, unless the test scripts another; the
 * create records its ledger row only when `release` is called. The platform's pass archives the
 * deleted thread's live rows, as the desktop's does, and records which threads Core still listed
 * when it ran.
 */
async function worktreeHost(
  options: {
    readonly model?: MockLanguageModelV4;
    readonly pass?: (threadId: string) => Promise<void>;
  } = {}
) {
  const { pass } = options;
  const creating = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held: { reads?: HostThreadReads; store?: StateStore } = {};
  const passes: Pass[] = [];
  const listedDuringPass: string[][] = [];
  const archiveThread = async (threadId: string): Promise<void> => {
    const { reads, store } = held;
    if (!(reads && store)) {
      throw new Error('The host has not opened');
    }
    listedDuringPass.push((await reads.listThreads()).map((thread) => thread.threadId));
    const { rows } = await store.worktreeLedger({ operation: 'list-thread', threadId });
    for (const row of rows) {
      await store.worktreeLedger({
        id: row.id,
        operation: 'archive',
        snapshotRef: `refs/brainstrike/worktree-archive/${row.id}`,
      });
    }
  };
  const idleWorktreeArchives: NonNullable<HostPlatform['idleWorktreeArchives']> = {
    afterThreadDeleted: (threadId) => {
      const done = (pass ?? archiveThread)(threadId);
      passes.push({ done, threadId });
      return done;
    },
    settle: async () => undefined,
    subscribe: () => () => undefined,
  };
  const model =
    options.model ??
    new MockLanguageModelV4({
      doStream: async (call) =>
        stream(
          call.prompt.some((message) => message.role === 'tool')
            ? text('Made it.')
            : toolCall('manage_worktree', { action: 'create' }, 'create-1')
        ),
    });
  const harness = await setupChildRunHost(model, cleanup, {
    attachThreadReads: (reads) => {
      held.reads = reads;
    },
    idleWorktreeArchives,
    tools: {
      manage_worktree: {
        description: 'Create a managed worktree',
        // The create finishes whatever its run does meanwhile, and records its row.
        execute: async (_input, context) => {
          creating.resolve();
          await release.promise;
          await harness.store.worktreeLedger({
            operation: 'insert',
            row: madeRow(context.threadId, context.runId),
          });
          return { worktreeId: 'wt-never-entered' };
        },
        identity: 'native-manage-worktree-generation-1',
        inputSchema: z.object({ action: z.literal('create') }),
        risk: 'edit',
      },
    },
  });
  held.store = harness.store;
  const activeRows = async () =>
    (await harness.store.worktreeLedger({ operation: 'list-thread', threadId: harness.threadId }))
      .rows;
  return {
    activeRows,
    creating: creating.promise,
    harness,
    listedDuringPass,
    passes,
    release: release.resolve,
  };
}

test('a thread whose run was stopped while manageWorktree create ran leaves no active ledger row once deleted', async () => {
  const { activeRows, creating, harness, listedDuringPass, passes, release } = await worktreeHost();
  const runId = await harness.start('Make a worktree to work in.');
  await creating;
  const stopping = harness
    .core()
    .stop({ commandId: randomUUID(), runId, threadId: harness.threadId });
  release();
  expect(await stopping).toEqual({ outcome: 'stopped' });
  // The create finished after the Stop: its worktree is in the ledger, and no thread entered it.
  expect((await activeRows()).map(({ id }) => id)).toEqual(['wt-never-entered']);

  await harness.core().deleteThread({ threadId: harness.threadId });

  expect(passes.map(({ threadId }) => threadId)).toEqual([harness.threadId]);
  await Promise.all(passes.map(({ done }) => done));
  expect(await activeRows()).toEqual([]);
  // The deletion had committed: Core no longer listed the thread when the pass read its threads.
  expect(listedDuringPass).toEqual([[]]);
});

test('a thread deleted while manageWorktree create runs leaves no active ledger row', async () => {
  const { activeRows, creating, harness, passes, release } = await worktreeHost();
  await harness.start('Make a worktree to work in.');
  await creating;

  const deleting = harness.core().deleteThread({ threadId: harness.threadId });
  release();
  expect(await deleting).toEqual({ deleted: true, threadIds: [harness.threadId] });

  await Promise.all(passes.map(({ done }) => done));
  expect(await activeRows()).toEqual([]);
});

test('the deletion answers while the platform is still archiving', async () => {
  const archiving = Promise.withResolvers<void>();
  cleanup.push(async () => archiving.resolve());
  const { creating, harness, passes, release } = await worktreeHost({
    pass: () => archiving.promise,
  });
  await harness.start('Make a worktree to work in.');
  await creating;
  release();
  await harness.core().idle(harness.threadId);

  expect(await harness.core().deleteThread({ threadId: harness.threadId })).toEqual({
    deleted: true,
    threadIds: [harness.threadId],
  });
  expect(passes.map(({ threadId }) => threadId)).toEqual([harness.threadId]);
});

// There is no thread left to tell: the failure is logged, and the deletion stands.
test('an archive that fails does not fail the deletion', async () => {
  const { creating, harness, passes, release } = await worktreeHost({
    pass: async () => {
      throw new Error('git is not available');
    },
  });
  await harness.start('Make a worktree to work in.');
  await creating;
  release();
  await harness.core().idle(harness.threadId);

  expect(await harness.core().deleteThread({ threadId: harness.threadId })).toEqual({
    deleted: true,
    threadIds: [harness.threadId],
  });
  expect(passes).toHaveLength(1);
  await expect(harness.core().read(harness.threadId, 0)).rejects.toMatchObject({
    code: 'thread.unknown',
  });
});

// BST-1932: a thread's child threads are deleted with it, and each one's worktrees are archived.
test('deleting a thread archives the worktrees its child threads made too', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        return blocked(call);
      }
      return stream(
        call.prompt.some((message) => message.role === 'tool')
          ? text('Parent continues.')
          : toolCall('agent-explore', { prompt: 'Read the notes.' }, 'explore-1')
      );
    },
  });
  const { harness, passes } = await worktreeHost({ model });
  await harness.start('Delegate.');
  await expect.poll(() => childThreads(harness)).toHaveLength(1);
  const [child = ''] = await childThreads(harness);
  // The worker made a worktree its parent never entered.
  await harness.store.worktreeLedger({
    operation: 'insert',
    row: madeRow(child, 'run-of-the-worker', 'worker-made'),
  });

  expect(await harness.core().deleteThread({ threadId: harness.threadId })).toEqual({
    deleted: true,
    threadIds: expect.arrayContaining([harness.threadId, child]),
  });

  expect(passes.map(({ threadId }) => threadId).sort()).toEqual([harness.threadId, child].sort());
  await Promise.all(passes.map(({ done }) => done));
  expect(
    (await harness.store.worktreeLedger({ operation: 'list-thread', threadId: child })).rows
  ).toEqual([]);
});
