// A state catch-up step compiles no SQL per projected event: the projection's
// statements are prepared once on the writer's connection and reused, so a full
// step makes the same `db.prepare` calls as a one-event step (BST-2159).
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { largeText, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { STATE_CATCH_UP_STEP_EVENTS } from '../src/contracts.js';
import { openDesktopIndex } from '../src/desktop-index-connection.js';
import { loadStateProjection } from '../src/state-projection.js';
import { IndexWriter } from '../src/store.js';

const producer = new URL('./fixtures/state-search-schema.mjs', import.meta.url).href;
const events = STATE_CATCH_UP_STEP_EVENTS;

const owned: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const release of owned.splice(0).reverse()) {
    await release();
  }
});

/** A spooled blob, as `largeText` writes one, for the events below to reference. */
function spooledBlob(name: string) {
  const { blob } = largeText(`${name} ${'tool output '.repeat(1200)}`);
  if (!blob) {
    throw new Error('Fixture must create a real content-addressed blob');
  }
  return blob;
}

/**
 * A state log with thread `one` holding a single event and thread `many` a whole
 * step of them. Each event is a searchable answer that references both blobs, so
 * projecting it writes its event row, blob references and search row.
 */
async function seeded() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-statements-')));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const store = await StateStore.open(root);
  owned.push(() => store.close());
  const spooled = [spooledBlob('first'), spooledBlob('second')];
  const hashes = spooled.map((blob) => blob.hash);
  const answer = (index: number) => ({
    blobRefs: hashes,
    runId: 'run-1',
    text: `garden answer ${index}`,
    type: 'answer',
    v: 1,
  });
  await store.append([{ blobs: spooled, event: answer(0), threadId: 'one' }]);
  await store.append(
    Array.from({ length: events }, (_, index) => ({ event: answer(index), threadId: 'many' }))
  );
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['canonical'],
    stateProjection: { mode: 'dev', module: producer },
    stateRoot: root,
  } as const;
  const projection = await loadStateProjection(options.stateProjection, root);
  const index = new IndexWriter(options, openDesktopIndex(options, projection), projection);
  owned.push(() => index.close());
  return { hashes, index };
}

it('a catch-up step over many events prepares no more statements than a one-event step', async () => {
  const { hashes, index } = await seeded();
  const state = index.requireState();
  const prepare = vi.spyOn(index.db, 'prepare');
  /** The `db.prepare` calls of one catch-up step that brings `threadId` current. */
  const preparesFor = (threadId: string): number => {
    prepare.mockClear();
    expect(state.catchUpStep({ maxEvents: events, threads: [threadId] })).toBe(true);
    return prepare.mock.calls.length;
  };

  const single = preparesFor('one');
  expect(preparesFor('many')).toBe(single);
  // A rebuild's steps overwrite every row in place; they reuse the same statements.
  state.rebuild('many');
  expect(preparesFor('many')).toBe(single);
  prepare.mockRestore();

  // The steps projected every event: its row, both blob references and its search row.
  expect(state.stats('many')).toMatchObject({ cursor: events, docs: events });
  expect(state.gcCheck({ hashes, threads: ['one', 'many'] })).toEqual(
    Object.fromEntries(hashes.map((hash) => [hash, events + 1]))
  );
  expect(
    index.db.prepare("SELECT count(*) FROM state_search_rows WHERE thread_id='many'").pluck().get()
  ).toBe(events);
});
