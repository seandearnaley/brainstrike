// The derived state index catches up in bounded requests, so no single request
// carries a whole backlog past its connection's deadline.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createStateStoreIndexer,
  openIndexer,
  STATE_CATCH_UP_STEP_EVENTS,
} from '@brainstrike/indexer';
import { type RunEvent, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, it } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const producer = new URL('./fixtures/state-search-schema.mjs', import.meta.url).href;

const owned: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of owned.splice(0).reverse()) {
    await release();
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-state-steps-')));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const port = await openIndexer(
    {
      dbPath: path.join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: ['canonical'],
      stateProjection: { mode: 'dev', module: producer },
      stateRoot: root,
    },
    deadlines
  );
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  owned.push(async () => {
    await store.close();
    await port.close();
  });
  return { port, store };
}

async function append(store: StateStore, threadId: string, count: number): Promise<void> {
  const events: RunEvent[] = Array.from({ length: count }, (_, index) => ({
    runId: 'run-1',
    text: `answer ${index}`,
    type: 'answer',
  }));
  await store.append(events.map((event) => ({ event: { v: 1, ...event }, threadId })));
}

it('projects a backlog in steps of at most maxEvents, each resuming where the last committed', async () => {
  const { port, store } = await fixture();
  await append(store, 'one', 5);
  await append(store, 'two', 3);

  await expect(port.catchUpStateStep(['one', 'two'], 3)).resolves.toBe(false);
  expect((await port.stateStats('one')).cursor).toBe(3);
  expect((await port.stateStats('two')).cursor).toBe(0);
  await expect(port.catchUpStateStep(['one', 'two'], 3)).resolves.toBe(false);
  expect((await port.stateStats('one')).cursor).toBe(5);
  expect((await port.stateStats('two')).cursor).toBe(1);
  await expect(port.catchUpStateStep(['one', 'two'], 3)).resolves.toBe(true);
  expect((await port.stateStats('two')).cursor).toBe(3);
  await expect(port.catchUpStateStep(['one', 'two'], 3)).resolves.toBe(true);
});

it('a blob count over a backlog larger than a step catches it all up and counts', async () => {
  const { port, store } = await fixture();
  const backlog = STATE_CATCH_UP_STEP_EVENTS * 2 + 1;
  await append(store, 'one', backlog);

  await expect(createStateStoreIndexer(port).gcCheck(['one'], ['a'.repeat(64)])).resolves.toEqual({
    ['a'.repeat(64)]: 0,
  });
  expect((await port.stateStats('one')).cursor).toBe(backlog);
});

it('a rebuild resets a thread and re-projects all of it, however long', async () => {
  const { port, store } = await fixture();
  await append(store, 'one', STATE_CATCH_UP_STEP_EVENTS + 3);
  await port.catchUpState(['one']);
  const projected = await port.stateStats('one');

  await port.rebuildState('one');
  expect(await port.stateStats('one')).toEqual(projected);
});
