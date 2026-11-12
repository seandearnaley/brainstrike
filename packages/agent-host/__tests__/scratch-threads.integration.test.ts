/**
 * ADR-0034 scratch threads (Sean, 2026-11-12): a thread first sent while it
 * has no folder and no folder is open in the workspace works in a folder the
 * host makes for it under `<userData>/scratch`, trusted with no question and
 * bound before its run is admitted, so its file tools work from the first
 * message. With a folder open nothing is made. Deleting the thread moves its
 * folder to the system Trash.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { readHostWorkspaceTrust } from '../src/workspace-trust.js';
import { rowsWhere, scripted, startedRuns, write } from './fixtures/automatic-isolation-host.js';
import { finished, stream, text } from './fixtures/child-run-host.js';
import { OPEN, scratchThreadHost } from './fixtures/scratch-thread-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** Every thread writes `notes.txt` where it works, then answers. */
const writesNotes = () =>
  scripted({
    'S:': (turn) =>
      stream(turn.answered === 0 ? write('notes.txt', `write-${randomUUID()}`) : text('Done.')),
  });

const host = () => scratchThreadHost(writesNotes(), cleanup);

/** The thread's turn ended, and what its write answered. */
async function finishedTurn(hosted: Awaited<ReturnType<typeof host>>, threadId: string) {
  const runId = startedRuns(await hosted.core.read(threadId, 0)).at(-1)?.runId ?? '';
  return await rowsWhere(hosted.core, threadId, (rows) => rows.some(finished(runId)));
}

test('a thread first sent with no folder, while none is open, writes into a trusted folder the host made for it', async () => {
  const hosted = await host();
  const threadId = await hosted.thread();

  const { root } = await hosted.core.scratchWorkspace({ commandId: randomUUID(), threadId });
  await hosted.run(threadId, 'S: write notes.txt.');
  await finishedTurn(hosted, threadId);

  // One folder, made under <userData>/scratch and named as a worktree is.
  expect(await hosted.scratchFolders()).toEqual(['quiet-otter-1']);
  expect(root).toEqual({
    displayName: 'quiet-otter-1',
    path: join(hosted.scratchDirectory, 'quiet-otter-1'),
    rootId: expect.stringMatching(/\S/u),
  });
  // The thread works there: its binding names it, and its run was admitted with it.
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toEqual({
    operatingRootDisplayName: 'quiet-otter-1',
    operatingRootId: root?.rootId,
    operatingRootPath: root?.path,
  });
  expect(hosted.requests[0]?.workspaceBinding?.operatingRootId).toBe(root?.rootId);
  // The file tool wrote into it from the first message.
  expect(await hosted.read(root?.rootId ?? '', 'notes.txt')).toBe('notes.txt content');
  // The app made it, so it is trusted with no question (ADR-0032).
  expect(await readHostWorkspaceTrust(hosted.store, root?.path ?? '')).toBe('trusted');
  // It is recorded as the thread's scratch folder, a root that is never an open folder.
  expect((await hosted.store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([]);
  expect(
    (await hosted.store.workspaceRoots({ operation: 'scratch-of-thread', threadId })).roots
  ).toEqual([expect.objectContaining({ id: root?.rootId, kind: 'scratch', projectId: null })]);
});

test('with a folder open, a thread with no folder gets none made, and its run works in the open folder', async () => {
  const hosted = await host();
  await hosted.open();
  const threadId = await hosted.thread();

  expect(await hosted.core.scratchWorkspace({ commandId: randomUUID(), threadId })).toEqual({
    root: null,
  });
  await hosted.run(threadId, 'S: write notes.txt.');
  await finishedTurn(hosted, threadId);

  expect(await hosted.scratchFolders()).toEqual([]);
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toBeNull();
  expect(hosted.requests[0]?.workspaceBinding).toBeUndefined();
  expect(await hosted.read(OPEN, 'notes.txt')).toBe('notes.txt content');
});

test('a second send works in the same folder, and asking again makes no second one', async () => {
  const hosted = await host();
  const threadId = await hosted.thread();
  const { root } = await hosted.core.scratchWorkspace({ commandId: randomUUID(), threadId });
  await hosted.run(threadId, 'S: write notes.txt.');
  await finishedTurn(hosted, threadId);

  expect(await hosted.core.scratchWorkspace({ commandId: randomUUID(), threadId })).toEqual({
    root,
  });
  await hosted.run(threadId, 'S: write notes.txt again.');
  const rows = await finishedTurn(hosted, threadId);

  expect(startedRuns(rows)).toHaveLength(2);
  expect(hosted.requests.map((request) => request.workspaceBinding?.operatingRootId)).toEqual([
    root?.rootId,
    root?.rootId,
  ]);
  expect(await hosted.scratchFolders()).toEqual(['quiet-otter-1']);
});

test('deleting the thread moves its scratch folder to the Trash and forgets it', async () => {
  const hosted = await host();
  const threadId = await hosted.thread();
  const { root } = await hosted.core.scratchWorkspace({ commandId: randomUUID(), threadId });
  await hosted.run(threadId, 'S: write notes.txt.');
  await finishedTurn(hosted, threadId);
  const path = root?.path ?? '';

  await hosted.core.deleteThread({ threadId });

  expect(hosted.trashed).toEqual([path]);
  expect(await hosted.trashContents()).toEqual(['quiet-otter-1']);
  expect(await hosted.scratchFolders()).toEqual([]);
  expect((await hosted.store.workspaceRoots({ operation: 'list' })).roots).toEqual([]);
  expect(
    (await hosted.store.workspaceRoots({ operation: 'scratch-of-thread', threadId })).roots
  ).toEqual([]);
  // No answer outlives its folder: a folder made at that path again would be asked about anew.
  expect(await hosted.store.getSetting(`workspace.trust/${path}`)).toBeUndefined();
});

test('a scratch folder the Trash refuses leaves the thread deleted, and the deletion says where the folder is and why', async () => {
  const hosted = await host();
  const threadId = await hosted.thread();
  const { root } = await hosted.core.scratchWorkspace({ commandId: randomUUID(), threadId });
  await hosted.run(threadId, 'S: write notes.txt.');
  await finishedTurn(hosted, threadId);
  // As Main refuses a move the system Trash cannot make (`scratch-folder-trash.ts`).
  hosted.harness.failTrash = refusalError(
    'availability',
    'workspace.trash-failed',
    'The Trash is not available on this volume'
  );

  await expect(hosted.core.deleteThread({ threadId })).resolves.toEqual({
    deleted: true,
    scratchFolderNotRetired: {
      path: root?.path,
      reason: expect.stringContaining('The Trash is not available on this volume'),
    },
    threadIds: [threadId],
  });

  // The thread is gone, as any deleted thread is; its folder stays where it was, unmoved.
  expect(hosted.core.listThreads().map((thread) => thread.threadId)).toEqual([]);
  expect(await hosted.scratchFolders()).toEqual(['quiet-otter-1']);
  expect(hosted.trashed).toEqual([]);
});
