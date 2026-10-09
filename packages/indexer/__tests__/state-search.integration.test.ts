// Gap 10: message-level search rows in the host's derived state index.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
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
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-state-search-')));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['canonical'],
    stateProjection: { mode: 'dev', module: producer },
    stateRoot: root,
  } as const;
  const port = await openIndexer(options, deadlines);
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  const close = async () => {
    await store.close();
    await port.close();
  };
  owned.push(close);
  return { close, options, port, root, store };
}

const append = (
  store: StateStore,
  threadId: string,
  events: readonly RunEvent[]
): Promise<unknown> =>
  store.append(events.map((event) => ({ event: { v: 1, ...event }, threadId })));

it('searches message text across the requested threads, with its role, run and a marked snippet', async () => {
  const f = await fixture();
  await append(f.store, 'one', [
    { prompt: 'Draft the release plan for Friday', runId: 'run-1', type: 'prompt' },
    { output: 'release plan tool output', type: 'tool' },
    { runId: 'run-1', text: 'Here is the release plan: ship on Friday.', type: 'answer' },
  ]);
  await append(f.store, 'two', [
    { prompt: 'What is the weather?', runId: 'run-2', type: 'prompt' },
    { runId: 'run-2', text: 'The release plan is unrelated to rain.', type: 'answer' },
  ]);
  // No explicit catch-up: a search reads its threads' committed truth first.

  const hits = await f.port.searchState({
    limit: 10,
    query: 'release plan',
    threadIds: ['one', 'two'],
  });
  // Every query word must match; a tool output is never a conversation row.
  expect(hits.map(({ role, runId, seq, threadId }) => ({ role, runId, seq, threadId }))).toEqual(
    expect.arrayContaining([
      { role: 'user', runId: 'run-1', seq: 1, threadId: 'one' },
      { role: 'assistant', runId: 'run-1', seq: 3, threadId: 'one' },
      { role: 'assistant', runId: 'run-2', seq: 2, threadId: 'two' },
    ])
  );
  expect(hits).toHaveLength(3);
  expect(hits.every(({ snippet }) => snippet.includes('<mark>'))).toBe(true);
  const ranks = hits.map(({ rank }) => rank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

  // Only the requested threads are searched.
  expect(
    (await f.port.searchState({ limit: 10, query: 'release plan', threadIds: ['two'] })).map(
      ({ threadId }) => threadId
    )
  ).toEqual(['two']);
  expect(
    await f.port.searchState({ limit: 10, query: 'weather Friday', threadIds: ['one', 'two'] })
  ).toEqual([]);
});

it('a purged event and a deleted thread leave no search rows', async () => {
  const f = await fixture();
  await append(f.store, 'one', [
    { prompt: 'Remember the orchid code', runId: 'run-1', type: 'prompt' },
    { runId: 'run-1', text: 'The orchid code is noted.', type: 'answer' },
  ]);
  await append(f.store, 'two', [
    { prompt: 'Another orchid question', runId: 'run-2', type: 'prompt' },
  ]);
  await f.port.catchUpState(['one', 'two']);
  const search = () =>
    f.port.searchState({ limit: 10, query: 'orchid', threadIds: ['one', 'two'] });
  expect(await search()).toHaveLength(3);

  await f.store.purge('one', 1);
  expect((await search()).map(({ seq, threadId }) => ({ seq, threadId }))).toEqual(
    expect.arrayContaining([
      { seq: 2, threadId: 'one' },
      { seq: 1, threadId: 'two' },
    ])
  );
  expect(await search()).toHaveLength(2);

  await f.store.deleteThread('one');
  expect((await search()).map(({ threadId }) => threadId)).toEqual(['two']);
  const db = openConnection(f.options.dbPath, { readonly: true });
  try {
    expect(
      db.prepare("SELECT count(*) FROM state_search_rows WHERE thread_id='one'").pluck().get()
    ).toBe(0);
  } finally {
    db.close();
  }
});

it('an upgraded schema 10 store projects search rows from the events it already holds', async () => {
  const f = await fixture();
  await append(f.store, 'one', [
    { prompt: 'Saffron notes for dinner', runId: 'run-1', type: 'prompt' },
    { runId: 'run-1', text: 'Saffron goes in last.', type: 'answer' },
  ]);
  await f.port.catchUpState(['one']);
  await f.close();
  owned.splice(owned.indexOf(f.close), 1);
  // The schema 10 layout: no search or search-vector storage, everything else unchanged.
  const db = openConnection(f.options.dbPath);
  try {
    db.exec(
      'DROP TABLE state_search_vector_failures; DROP TABLE state_search_vectors; DROP TABLE state_search_fts; DROP TABLE state_search_rows;'
    );
    db.prepare('UPDATE index_metadata SET schema_version=10').run();
  } finally {
    db.close();
  }
  const port = await openIndexer(f.options, deadlines);
  owned.push(() => port.close());
  expect(
    (await port.searchState({ limit: 10, query: 'saffron', threadIds: ['one'] })).map(
      ({ role, seq }) => ({ role, seq })
    )
  ).toEqual(
    expect.arrayContaining([
      { role: 'user', seq: 1 },
      { role: 'assistant', seq: 2 },
    ])
  );
  const upgraded = openConnection(f.options.dbPath, { readonly: true });
  try {
    expect(upgraded.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(13);
  } finally {
    upgraded.close();
  }
});
