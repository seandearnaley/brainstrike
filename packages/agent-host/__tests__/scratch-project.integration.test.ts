/**
 * ADR-0034 build decisions: a scratch thread's folder becomes a project ("Turn
 * into a project…" in the where-control). The person chooses a folder with
 * Main's picker; the scratch folder moves into it under its own name, its root
 * becomes a folder of the person's with a project of its own under the same
 * root id, and the thread's binding follows it there. Like every checkout
 * change it waits for the thread's run to end.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readHostWorkspaceTrust } from '../src/workspace-trust.js';
import { rowsWhere, scripted, startedRuns, write } from './fixtures/automatic-isolation-host.js';
import { blocked, finished, stream, text } from './fixtures/child-run-host.js';
import { scratchThreadHost } from './fixtures/scratch-thread-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** "S:" threads write `notes.txt` where they work, then answer; "B:" threads keep working. */
const model = () =>
  scripted({
    'B:': (_turn, call) => blocked(call),
    'S:': (turn) =>
      stream(turn.answered === 0 ? write('notes.txt', `write-${randomUUID()}`) : text('Done.')),
  });

const host = () => scratchThreadHost(model(), cleanup);
type Hosted = Awaited<ReturnType<typeof host>>;

async function finishedTurn(hosted: Hosted, threadId: string) {
  const runId = startedRuns(await hosted.core.read(threadId, 0)).at(-1)?.runId ?? '';
  return await rowsWhere(hosted.core, threadId, (rows) => rows.some(finished(runId)));
}

/** A thread that worked in its scratch folder, and a folder of the person's to put projects in. */
async function scratchThread(hosted: Hosted) {
  const threadId = await hosted.thread();
  const { root } = await hosted.core.scratchWorkspace({ commandId: randomUUID(), threadId });
  await hosted.run(threadId, 'S: write notes.txt.');
  await finishedTurn(hosted, threadId);
  const projects = join(hosted.base, 'Projects');
  await mkdir(projects);
  return { projects, root, threadId };
}

const turnIntoProject = (hosted: Hosted, threadId: string) =>
  hosted.core.scratchProject({ commandId: randomUUID(), threadId });

test('the scratch folder moves into the folder the person chose and becomes a project, and the thread follows it there', async () => {
  const hosted = await host();
  const { projects, root, threadId } = await scratchThread(hosted);
  const place = join(projects, 'quiet-otter-1');
  hosted.harness.picks.push(projects);

  await expect(turnIntoProject(hosted, threadId)).resolves.toEqual({
    root: { displayName: 'quiet-otter-1', path: place, rootId: root?.rootId },
  });

  // The folder moved, with its work, and nothing is left under <userData>/scratch.
  expect(await readFile(join(place, 'notes.txt'), 'utf8')).toBe('notes.txt content');
  expect(await hosted.scratchFolders()).toEqual([]);
  // Its record kept its id and is a folder of the person's now, open, with a project of its own.
  expect((await hosted.store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([
    expect.objectContaining({
      id: root?.rootId,
      kind: 'path',
      path: place,
      projectId: expect.stringMatching(/\S/u),
    }),
  ]);
  expect(
    (await hosted.store.workspaceRoots({ operation: 'scratch-of-thread', threadId })).roots
  ).toEqual([]);
  // The thread's binding follows it, through the binding's own command.
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toEqual({
    operatingRootDisplayName: 'quiet-otter-1',
    operatingRootId: root?.rootId,
    operatingRootPath: place,
  });
  // The person chose the place, so its trust is asked there: nothing was written for it.
  expect(await readHostWorkspaceTrust(hosted.store, place)).toBe('undecided');

  // The thread's next run works in the project, under the same root.
  await writeFile(join(place, 'notes.txt'), 'kept');
  await hosted.run(threadId, 'S: write notes.txt again.');
  await finishedTurn(hosted, threadId);
  expect(hosted.requests.at(-1)?.workspaceBinding).toMatchObject({
    operatingRootId: root?.rootId,
    operatingRootPath: place,
  });
  expect(await readFile(join(place, 'notes.txt'), 'utf8')).toBe('notes.txt content');

  // A project is not a scratch folder: deleting the thread leaves it where it is.
  await hosted.core.deleteThread({ threadId });
  expect(hosted.trashed).toEqual([]);
  expect(await readdir(place)).toEqual(['notes.txt']);
});

test('a cancelled picker changes nothing', async () => {
  const hosted = await host();
  const { root, threadId } = await scratchThread(hosted);
  hosted.harness.picks.push(null);

  await expect(turnIntoProject(hosted, threadId)).resolves.toEqual({ root: null });

  expect(hosted.harness.picked).toBe(1);
  expect(await hosted.scratchFolders()).toEqual(['quiet-otter-1']);
  expect(hosted.core.readWorkspaceBinding(threadId).binding?.operatingRootPath).toBe(root?.path);
});

test('a place that is taken is refused, and the folder stays where it was', async () => {
  const hosted = await host();
  const { projects, root, threadId } = await scratchThread(hosted);
  await mkdir(join(projects, 'quiet-otter-1'));
  hosted.harness.picks.push(projects);

  await expect(turnIntoProject(hosted, threadId)).rejects.toMatchObject({
    failure: {
      code: 'workspace.scratch-project-exists',
      kind: 'refusal',
      message: expect.stringContaining(join(projects, 'quiet-otter-1')),
    },
  });

  expect(await hosted.scratchFolders()).toEqual(['quiet-otter-1']);
  expect(await readdir(join(projects, 'quiet-otter-1'))).toEqual([]);
  expect(
    (await hosted.store.workspaceRoots({ operation: 'scratch-of-thread', threadId })).roots
  ).toEqual([expect.objectContaining({ id: root?.rootId, kind: 'scratch' })]);
});

test('a folder on another disk is refused with the reason, and nothing is copied', async () => {
  const hosted = await host();
  const { projects, root, threadId } = await scratchThread(hosted);
  hosted.harness.picks.push(projects);
  // As rename(2) answers for a destination on another file system.
  hosted.harness.failMove = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
    code: 'EXDEV',
  });

  await expect(turnIntoProject(hosted, threadId)).rejects.toMatchObject({
    failure: {
      code: 'workspace.scratch-project-other-disk',
      kind: 'refusal',
      message: expect.stringContaining('another disk'),
    },
  });

  expect(await readdir(projects)).toEqual([]);
  expect(await hosted.scratchFolders()).toEqual(['quiet-otter-1']);
  expect(hosted.core.readWorkspaceBinding(threadId).binding?.operatingRootPath).toBe(root?.path);
});

test("it waits for the thread's run to end: refused while one is in progress, before the picker is shown", async () => {
  const hosted = await host();
  const { projects, root, threadId } = await scratchThread(hosted);
  const runId = await hosted.run(threadId, 'B: keep working.');
  hosted.harness.picks.push(projects);

  await expect(turnIntoProject(hosted, threadId)).rejects.toMatchObject({
    failure: { code: 'workspace.scratch-project-running', kind: 'refusal' },
  });
  expect(hosted.harness.picked).toBe(0);
  expect(await hosted.scratchFolders()).toEqual(['quiet-otter-1']);

  await hosted.core.stop({ commandId: randomUUID(), runId, threadId });
  await rowsWhere(hosted.core, threadId, (rows) => rows.some(finished(runId)));
  await expect(turnIntoProject(hosted, threadId)).resolves.toEqual({
    root: expect.objectContaining({ rootId: root?.rootId }),
  });
});

test('a thread that does not work in a scratch folder has nothing to turn into a project', async () => {
  const hosted = await host();
  await hosted.open();
  const threadId = await hosted.thread();
  await hosted.run(threadId, 'S: write notes.txt.');
  await finishedTurn(hosted, threadId);

  await expect(turnIntoProject(hosted, threadId)).rejects.toMatchObject({
    failure: { code: 'workspace.scratch-none', kind: 'refusal' },
  });
  expect(hosted.harness.picked).toBe(0);
});
