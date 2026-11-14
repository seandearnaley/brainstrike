/**
 * BST-2516 (ADR-0034 relink): Locate folder… points a folder's record at the place the folder
 * moved to, under the same root id. Every thread whose binding names that root as where it works
 * follows it there: the host rewrites the binding's folder path and name through the binding's
 * own command, so the thread's next run is admitted at the new place instead of being refused
 * for naming the old one.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { HOST_VERSION } from '@brainstrike/host-lease';
import { afterEach, expect, test } from 'vitest';
import { authenticateHostClient } from '../src/client-connection.js';
import { bindHostConnection } from '../src/connection.js';
import type { HostRootRegistry } from '../src/ports.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol-version.js';
import { nodePortConnection } from '../src/transports.js';
import { rowsWhere, scripted, startedRuns, write } from './fixtures/automatic-isolation-host.js';
import { finished, stream, text } from './fixtures/child-run-host.js';
import { scratchThreadHost } from './fixtures/scratch-thread-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const ROOT_ID = 'survey-root';

/** "S:" threads write `notes.txt` where they work, then answer. */
const model = () =>
  scripted({
    'S:': (turn) =>
      stream(turn.answered === 0 ? write('notes.txt', `write-${randomUUID()}`) : text('Done.')),
  });

type Hosted = Awaited<ReturnType<typeof scratchThreadHost>>;

async function finishedTurn(hosted: Hosted, threadId: string) {
  const runId = startedRuns(await hosted.core.read(threadId, 0)).at(-1)?.runId ?? '';
  return await rowsWhere(hosted.core, threadId, (rows) => rows.some(finished(runId)));
}

/** The desktop's private client, over a real connection to Core, with the registry's Locate. */
async function desktopClient(hosted: Hosted, locate: HostRootRegistry['workspace/roots/locate']) {
  const rootRegistry = { 'workspace/roots/locate': locate } as unknown as HostRootRegistry;
  const record = {
    hostVersion: HOST_VERSION,
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'start',
  };
  const channel = new MessageChannel();
  const server = nodePortConnection(channel.port1);
  bindHostConnection(server, hosted.core, record, () => undefined, {
    origin: 'desktop-ui',
    rootRegistry,
  });
  const closed = Promise.withResolvers<void>();
  const client = await authenticateHostClient(
    nodePortConnection(channel.port2),
    record,
    async () => {
      channel.port2.close();
      channel.port1.close();
      server.dispose();
      closed.resolve();
    },
    closed.promise
  );
  cleanup.push(async () => {
    await client.close();
  });
  return client;
}

/** The registry's Locate: Main's picker answers `moved`, and the record is pointed there. */
const locatedAt =
  (hosted: Hosted, moved: string): HostRootRegistry['workspace/roots/locate'] =>
  async ({ rootId }) => {
    await hosted.folder(rootId, moved);
    return { root: { available: true, path: moved, rootId, scratch: false, worktree: false } };
  };

/** A folder of the person's, and threads that worked in it before it moved. */
async function threadsInFolder(hosted: Hosted, count: number) {
  const place = join(hosted.base, 'survey');
  await mkdir(place);
  await hosted.folder(ROOT_ID, place);
  const threadIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const threadId = await hosted.thread();
    await hosted.core.updateWorkspaceBinding({
      commandId: randomUUID(),
      patch: {
        operatingRootDisplayName: 'survey',
        operatingRootId: ROOT_ID,
        operatingRootPath: place,
      },
      threadId,
    });
    await hosted.run(threadId, 'S: write notes.txt.');
    await finishedTurn(hosted, threadId);
    threadIds.push(threadId);
  }
  return { place, threadIds };
}

test("after Locate folder…, the folder's thread names where it is now and its next run works there", async () => {
  const hosted = await scratchThreadHost(model(), cleanup);
  const { place, threadIds } = await threadsInFolder(hosted, 1);
  const [threadId = ''] = threadIds;
  // The folder moved outside the app.
  const moved = join(hosted.base, 'survey-moved');
  await rename(place, moved);
  const client = await desktopClient(hosted, locatedAt(hosted, moved));

  await expect(client.request('workspace/roots/locate', { rootId: ROOT_ID })).resolves.toEqual({
    root: expect.objectContaining({ path: moved, rootId: ROOT_ID }),
  });

  expect(hosted.core.readWorkspaceBinding(threadId).binding).toEqual({
    operatingRootDisplayName: 'survey-moved',
    operatingRootId: ROOT_ID,
    operatingRootPath: moved,
  });
  const asked = hosted.requests.length;
  await hosted.run(threadId, 'S: write notes.txt again.');
  await finishedTurn(hosted, threadId);
  expect(hosted.requests.slice(asked).map((request) => request.workspaceBinding)).toEqual([
    {
      operatingRootDisplayName: 'survey-moved',
      operatingRootId: ROOT_ID,
      operatingRootPath: moved,
    },
  ]);
  expect(await readFile(join(moved, 'notes.txt'), 'utf8')).toBe('notes.txt content');
});

test('every thread that works in the located folder follows it, and a thread elsewhere keeps its binding', async () => {
  const hosted = await scratchThreadHost(model(), cleanup);
  const { place, threadIds } = await threadsInFolder(hosted, 2);
  await hosted.open();
  const elsewhere = await hosted.thread();
  const openBinding = { operatingRootDisplayName: 'project', operatingRootId: 'open-root' };
  await hosted.core.updateWorkspaceBinding({
    commandId: randomUUID(),
    patch: openBinding,
    threadId: elsewhere,
  });
  const moved = join(hosted.base, 'survey-moved');
  await rename(place, moved);
  const client = await desktopClient(hosted, locatedAt(hosted, moved));

  await client.request('workspace/roots/locate', { rootId: ROOT_ID });

  for (const threadId of threadIds) {
    expect(hosted.core.readWorkspaceBinding(threadId).binding).toMatchObject({
      operatingRootDisplayName: 'survey-moved',
      operatingRootId: ROOT_ID,
      operatingRootPath: moved,
    });
  }
  expect(hosted.core.readWorkspaceBinding(elsewhere).binding).toEqual(openBinding);
});

test('a cancelled picker leaves every binding as it was', async () => {
  const hosted = await scratchThreadHost(model(), cleanup);
  const { place, threadIds } = await threadsInFolder(hosted, 1);
  const [threadId = ''] = threadIds;
  const before = hosted.core.readWorkspaceBinding(threadId).binding;
  const client = await desktopClient(hosted, async () => ({ root: null }));

  await expect(client.request('workspace/roots/locate', { rootId: ROOT_ID })).resolves.toEqual({
    root: null,
  });
  expect(hosted.core.readWorkspaceBinding(threadId).binding).toEqual(before);
  expect(before?.operatingRootPath).toBe(place);
});
