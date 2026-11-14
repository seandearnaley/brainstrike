/**
 * ADR-0034 build decisions (BST-2513): New project folder… gives a thread that works with no
 * folder of its own a new folder the person places. A thread first sent while a folder was open
 * runs against the open folders and has no binding; once they close, its file tools refuse. The
 * person chooses a parent with Main's picker, the host makes `<parent>/<name>` there (the name is
 * the thread's title, slugged, else the scratch name generator's), opens it as a folder of the
 * person's with a project of its own, and binds the thread to it. Like every checkout change it
 * waits for the thread's run to end.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readHostWorkspaceTrust } from '../src/workspace-trust.js';
import { rowsWhere, scripted, startedRuns, write } from './fixtures/automatic-isolation-host.js';
import { blocked, finished, stream, text } from './fixtures/child-run-host.js';
import { OPEN, scratchThreadHost } from './fixtures/scratch-thread-host.js';

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

/**
 * A thread first sent while a folder was open, so it has no folder of its own, after that folder
 * closed; and a folder of the person's to put projects in.
 */
async function folderlessThread(hosted: Hosted, title?: string) {
  await hosted.open();
  const threadId = await hosted.thread();
  await hosted.run(threadId, 'S: write notes.txt.');
  await finishedTurn(hosted, threadId);
  await hosted.close();
  if (title !== undefined) {
    await hosted.core.updateThread({ commandId: randomUUID(), threadId, title });
  }
  const projects = join(hosted.base, 'Projects');
  await mkdir(projects);
  return { projects, threadId };
}

const newProjectFolder = (hosted: Hosted, threadId: string) =>
  hosted.core.newProjectFolder({ commandId: randomUUID(), threadId });

test('a thread with no folder of its own gets a new project folder where the person places it, named by its title, and works there', async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted, 'Release notes: Q4 plan!');
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toBeNull();
  const place = join(projects, 'release-notes-q4-plan');
  hosted.harness.picks.push(projects);

  const { root } = await newProjectFolder(hosted, threadId);

  expect(root).toEqual({
    displayName: 'release-notes-q4-plan',
    path: place,
    rootId: expect.stringMatching(/\S/u),
  });
  // A new, empty folder at the place the person chose, made nowhere under <userData>/scratch.
  expect(await readdir(place)).toEqual([]);
  expect(await hosted.scratchFolders()).toEqual([]);
  // It is an open folder of the person's, with a project of its own.
  expect((await hosted.store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([
    expect.objectContaining({
      id: root?.rootId,
      kind: 'path',
      path: place,
      projectId: expect.stringMatching(/\S/u),
    }),
  ]);
  // The thread is bound to it, through the binding's own command.
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toEqual({
    operatingRootDisplayName: 'release-notes-q4-plan',
    operatingRootId: root?.rootId,
    operatingRootPath: place,
  });
  // The person placed it, so its trust is asked there as for any folder they open.
  expect(await readHostWorkspaceTrust(hosted.store, place)).toBe('undecided');

  // The thread's next run works in it.
  await hosted.run(threadId, 'S: write notes.txt again.');
  await finishedTurn(hosted, threadId);
  expect(hosted.requests.at(-1)?.workspaceBinding).toMatchObject({
    operatingRootId: root?.rootId,
    operatingRootPath: place,
  });
  expect(await readFile(join(place, 'notes.txt'), 'utf8')).toBe('notes.txt content');

  // A project folder is not a scratch folder: deleting the thread leaves it where it is.
  await hosted.core.deleteThread({ threadId });
  expect(hosted.trashed).toEqual([]);
  expect(await readdir(place)).toEqual(['notes.txt']);
});

test('a thread with no title is named as a scratch folder is', async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted);
  hosted.harness.picks.push(projects);

  await expect(newProjectFolder(hosted, threadId)).resolves.toEqual({
    root: expect.objectContaining({
      displayName: 'quiet-otter-1',
      path: join(projects, 'quiet-otter-1'),
    }),
  });
  expect(await readdir(projects)).toEqual(['quiet-otter-1']);
});

test('a cancelled picker changes nothing', async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted, 'Plan');
  hosted.harness.picks.push(null);

  await expect(newProjectFolder(hosted, threadId)).resolves.toEqual({ root: null });

  expect(hosted.harness.picked).toBe(1);
  expect(await readdir(projects)).toEqual([]);
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toBeNull();
});

test('a place that is taken is refused, and nothing is made or bound', async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted, 'Plan');
  const taken = join(projects, 'plan');
  await mkdir(taken);
  await writeFile(join(taken, 'theirs.txt'), 'already here');
  hosted.harness.picks.push(projects);

  await expect(newProjectFolder(hosted, threadId)).rejects.toMatchObject({
    failure: {
      code: 'workspace.folder-exists',
      kind: 'refusal',
      message: expect.stringContaining(taken),
    },
  });

  expect(await readdir(taken)).toEqual(['theirs.txt']);
  expect((await hosted.store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([]);
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toBeNull();
});

test('a parent the person cannot write to is refused with the reason', async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted, 'Plan');
  await chmod(projects, 0o555);
  hosted.harness.picks.push(projects);

  await expect(newProjectFolder(hosted, threadId)).rejects.toMatchObject({
    failure: {
      code: 'workspace.folder-not-writable',
      kind: 'refusal',
      message: expect.stringContaining(projects),
    },
  });
  await chmod(projects, 0o755);
  expect(await readdir(projects)).toEqual([]);
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toBeNull();
});

test('a parent among the scratch folders is refused, as no place for a project', async () => {
  const hosted = await host();
  const { threadId } = await folderlessThread(hosted, 'Plan');
  await mkdir(hosted.scratchDirectory, { recursive: true });
  hosted.harness.picks.push(hosted.scratchDirectory);

  await expect(newProjectFolder(hosted, threadId)).rejects.toMatchObject({
    failure: { code: 'workspace.folder-inside-scratch', kind: 'refusal' },
  });
  expect(await hosted.scratchFolders()).toEqual([]);
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toBeNull();
});

test('a folder the registry cannot open is removed again, and the thread keeps no folder', async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted, 'Plan');
  hosted.harness.picks.push(projects);
  hosted.harness.failOpen = new Error('The folder could not be mounted');

  await expect(newProjectFolder(hosted, threadId)).rejects.toThrow(
    'The folder could not be mounted'
  );

  expect(await readdir(projects)).toEqual([]);
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toBeNull();
});

test('a thread that already has a folder is refused before the picker is shown', async () => {
  const hosted = await host();
  // A scratch thread works in the folder the host made for it.
  const threadId = await hosted.thread();
  await hosted.core.scratchWorkspace({ commandId: randomUUID(), threadId });
  hosted.harness.picks.push(hosted.base);

  await expect(newProjectFolder(hosted, threadId)).rejects.toMatchObject({
    failure: { code: 'workspace.folder-has-binding', kind: 'refusal' },
  });
  expect(hosted.harness.picked).toBe(0);
});

test("it waits for the thread's run to end: refused while one is in progress, before the picker is shown", async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted, 'Plan');
  const runId = await hosted.run(threadId, 'B: keep working.');
  hosted.harness.picks.push(projects);

  await expect(newProjectFolder(hosted, threadId)).rejects.toMatchObject({
    failure: { code: 'workspace.folder-running', kind: 'refusal' },
  });
  expect(hosted.harness.picked).toBe(0);

  await hosted.core.stop({ commandId: randomUUID(), runId, threadId });
  await rowsWhere(hosted.core, threadId, (rows) => rows.some(finished(runId)));
  await expect(newProjectFolder(hosted, threadId)).resolves.toEqual({
    root: expect.objectContaining({ path: join(projects, 'plan') }),
  });
});

// The picker may stay open a while: what changed meanwhile is checked again in the admission slot.
test('a run started, or a folder bound, while the picker was open is refused once the person has chosen', async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted, 'Plan');
  // The person opens the folder again meanwhile, and the thread is bound to it.
  await hosted.open();
  hosted.harness.picks.push(projects, projects);

  const choose = Promise.withResolvers<void>();
  const shown = Promise.withResolvers<void>();
  hosted.harness.holdPick = choose.promise;
  hosted.harness.pickShown = shown.resolve;
  const refusedForRun = newProjectFolder(hosted, threadId);
  await shown.promise;
  const runId = await hosted.run(threadId, 'B: keep working.');
  choose.resolve();
  await expect(refusedForRun).rejects.toMatchObject({
    failure: { code: 'workspace.folder-running', kind: 'refusal' },
  });
  await hosted.core.stop({ commandId: randomUUID(), runId, threadId });
  await rowsWhere(hosted.core, threadId, (rows) => rows.some(finished(runId)));

  const chooseAgain = Promise.withResolvers<void>();
  const shownAgain = Promise.withResolvers<void>();
  hosted.harness.holdPick = chooseAgain.promise;
  hosted.harness.pickShown = shownAgain.resolve;
  const refusedForBinding = newProjectFolder(hosted, threadId);
  await shownAgain.promise;
  await hosted.core.updateWorkspaceBinding({
    commandId: randomUUID(),
    patch: { operatingRootDisplayName: 'project', operatingRootId: OPEN },
    threadId,
  });
  chooseAgain.resolve();
  await expect(refusedForBinding).rejects.toMatchObject({
    failure: { code: 'workspace.folder-has-binding', kind: 'refusal' },
  });

  expect(await readdir(projects)).toEqual([]);
});

// The last check, the folder's making, its opening and the binding share one slot of Core's
// admission queue, so a run asked for meanwhile is admitted after it, at the new folder.
test('a run asked for while the folder is made is admitted once the thread is bound, at the new folder', async () => {
  const hosted = await host();
  const { projects, threadId } = await folderlessThread(hosted, 'Plan');
  const place = join(projects, 'plan');
  hosted.harness.picks.push(projects);
  const hold = Promise.withResolvers<void>();
  const opening = Promise.withResolvers<void>();
  hosted.harness.holdOpen = hold.promise;
  hosted.harness.openStarted = opening.resolve;

  const made = newProjectFolder(hosted, threadId);
  await opening.promise;
  const asked = hosted.requests.length;
  const run = hosted.run(threadId, 'S: write notes.txt.');
  hold.resolve();

  const { root } = await made;
  expect(root).toEqual(expect.objectContaining({ path: place }));
  await run;
  await finishedTurn(hosted, threadId);
  expect(hosted.requests.slice(asked).map((request) => request.workspaceBinding)).toEqual([
    expect.objectContaining({ operatingRootId: root?.rootId, operatingRootPath: place }),
  ]);
  expect(await readFile(join(place, 'notes.txt'), 'utf8')).toBe('notes.txt content');
});
