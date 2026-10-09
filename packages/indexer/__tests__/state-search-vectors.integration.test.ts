// The Threads panel's semantic arm over the host's conversation rows.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { type RunEvent, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, it } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const producer = new URL('./fixtures/state-search-schema.mjs', import.meta.url).href;
const profile = {
  dimensions: 4,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'search-vector-proof',
  provider: 'local',
} as const;
/** One axis per topic, so cosine similarity names the nearest row exactly. */
const axis = (index: number): number[] => [0, 1, 2, 3].map((value) => (value === index ? 1 : 0));

const owned: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of owned.splice(0).reverse()) {
    await release();
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-search-vectors-')));
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
  const append = (threadId: string, events: readonly RunEvent[]): Promise<unknown> =>
    store.append(events.map((event) => ({ event: { v: 1, ...event }, threadId })));
  return { append, close, options, port, store };
}

/** A backlog row's address and source hash, as a caller returns them with its vector. */
function key(row: { seq: number; sourceHash: string; threadId: string } | undefined) {
  if (!row) {
    throw new Error('Expected a backlog row');
  }
  return { seq: row.seq, sourceHash: row.sourceHash, threadId: row.threadId };
}

/** Embeds each pending row by topic, as a renderer embedder would. */
function embed(rows: readonly { text: string }[]): number[][] {
  return rows.map(({ text }) =>
    axis(['garden', 'invoice', 'rocket'].findIndex((t) => text.includes(t)) + 1)
  );
}

it('embeds the backlog once, then finds the nearest rows of the requested threads', async () => {
  const f = await fixture();
  await f.append('one', [
    { prompt: 'Plan the garden beds', runId: 'run-1', type: 'prompt' },
    { output: 'tool output is never a row', type: 'tool' },
    { runId: 'run-1', text: 'The invoice is attached.', type: 'answer' },
  ]);
  await f.append('two', [{ prompt: 'Launch the rocket', runId: 'run-2', type: 'prompt' }]);

  // No explicit catch-up: the backlog reads its threads' committed truth first.
  const pending = await f.port.searchStatePending({
    limit: 10,
    profile,
    threadIds: ['one', 'two'],
  });
  expect(pending.map(({ seq, threadId }) => ({ seq, threadId }))).toEqual([
    { seq: 1, threadId: 'one' },
    { seq: 3, threadId: 'one' },
    { seq: 1, threadId: 'two' },
  ]);
  const vectors = embed(pending);
  expect(
    await f.port.putStateSearchVectors({
      profile,
      rows: pending.map(({ seq, sourceHash, threadId }, index) => ({
        seq,
        sourceHash,
        threadId,
        vector: vectors[index] ?? [],
      })),
    })
  ).toEqual({ failed: 0, stale: 0, stored: 3 });
  expect(
    await f.port.searchStatePending({ limit: 10, profile, threadIds: ['one', 'two'] })
  ).toEqual([]);
  // Another profile has its own backlog.
  expect(
    await f.port.searchStatePending({
      limit: 10,
      profile: { ...profile, modelId: 'another-model' },
      threadIds: ['one'],
    })
  ).toHaveLength(2);

  const similar = (vector: number[], threadIds: readonly string[]) =>
    f.port.searchStateSimilar({ limit: 10, profile, threadIds, threshold: 0.5, vector });
  expect(await similar(axis(2), ['one', 'two'])).toEqual([
    {
      role: 'assistant',
      runId: 'run-1',
      score: 1,
      seq: 3,
      text: 'The invoice is attached.',
      threadId: 'one',
    },
  ]);
  // Only the requested threads, and only at or above the threshold.
  expect(await similar(axis(3), ['one'])).toEqual([]);
  expect((await similar(axis(3), ['one', 'two'])).map(({ threadId }) => threadId)).toEqual(['two']);
});

it('stores no vector for a row whose text changed, and a deleted thread takes its vectors', async () => {
  const f = await fixture();
  await f.append('one', [{ prompt: 'Water the garden', runId: 'run-1', type: 'prompt' }]);
  await f.append('two', [{ prompt: 'Pay the invoice', runId: 'run-2', type: 'prompt' }]);
  const [first, second] = await f.port.searchStatePending({
    limit: 10,
    profile,
    threadIds: ['one', 'two'],
  });
  if (!(first && second)) {
    throw new Error('Expected two backlog rows');
  }
  // The row's text is not what was embedded.
  expect(
    await f.port.putStateSearchVectors({
      profile,
      rows: [
        { seq: first.seq, sourceHash: 'f'.repeat(64), threadId: first.threadId, vector: axis(1) },
        {
          seq: second.seq,
          sourceHash: second.sourceHash,
          threadId: second.threadId,
          vector: axis(2),
        },
      ],
    })
  ).toEqual({ failed: 0, stale: 1, stored: 1 });
  expect(
    (await f.port.searchStatePending({ limit: 10, profile, threadIds: ['one', 'two'] })).map(
      ({ threadId }) => threadId
    )
  ).toEqual(['one']);

  await f.store.deleteThread('two');
  expect(
    await f.port.searchStateSimilar({
      limit: 10,
      profile,
      threadIds: ['two'],
      threshold: -1,
      vector: axis(2),
    })
  ).toEqual([]);
});

it('rejects a vector whose dimensions disagree with its profile, storing none of the batch', async () => {
  const f = await fixture();
  await f.append('one', [
    { prompt: 'Garden notes', runId: 'run-1', type: 'prompt' },
    { runId: 'run-1', text: 'Rocket notes', type: 'answer' },
  ]);
  const pending = await f.port.searchStatePending({ limit: 10, profile, threadIds: ['one'] });
  await expect(
    f.port.putStateSearchVectors({
      profile,
      rows: [
        { ...key(pending[0]), vector: axis(1) },
        { ...key(pending[1]), vector: [1, 0] },
      ],
    })
  ).rejects.toThrow();
  expect(await f.port.searchStatePending({ limit: 10, profile, threadIds: ['one'] })).toHaveLength(
    2
  );
});

it('an upgraded schema 11 store gains search-vector and failure storage, with its rows as the backlog', async () => {
  const f = await fixture();
  await f.append('one', [{ prompt: 'Rocket launch notes', runId: 'run-1', type: 'prompt' }]);
  await f.port.catchUpState(['one']);
  await f.close();
  owned.splice(owned.indexOf(f.close), 1);
  // The schema 11 layout: search rows, no search vectors or failures.
  const db = openConnection(f.options.dbPath);
  try {
    db.exec('DROP TABLE state_search_vector_failures; DROP TABLE state_search_vectors;');
    db.prepare('UPDATE index_metadata SET schema_version=11').run();
  } finally {
    db.close();
  }
  const port = await openIndexer(f.options, deadlines);
  owned.push(() => port.close());
  expect(
    (await port.searchStatePending({ limit: 10, profile, threadIds: ['one'] })).map(
      ({ seq, text }) => ({ seq, text })
    )
  ).toEqual([{ seq: 1, text: 'Rocket launch notes' }]);
  const upgraded = openConnection(f.options.dbPath, { readonly: true });
  try {
    expect(upgraded.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(13);
  } finally {
    upgraded.close();
  }
});

it('records a row that failed to embed as errored, out of the backlog, until a vector clears it', async () => {
  const f = await fixture();
  await f.append('one', [
    { prompt: 'Garden notes', runId: 'run-1', type: 'prompt' },
    { runId: 'run-1', text: 'Invoice notes', type: 'answer' },
  ]);
  const [first, second] = await f.port.searchStatePending({
    limit: 10,
    profile,
    threadIds: ['one'],
  });
  expect(
    await f.port.putStateSearchVectors({
      profile,
      rows: [
        { ...key(first), error: 'model unavailable' },
        { ...key(second), vector: axis(2) },
      ],
    })
  ).toEqual({ failed: 1, stale: 0, stored: 1 });
  // The failed row is errored, not pending, as legacy's embedding_error is.
  expect(await f.port.searchStateCoverage({ profile, threadIds: ['one'] })).toEqual({
    embedded: 1,
    errored: 1,
    rows: 2,
  });
  expect(await f.port.searchStatePending({ limit: 10, profile, threadIds: ['one'] })).toEqual([]);
  // Another profile has no failure and no vector.
  expect(
    await f.port.searchStateCoverage({
      profile: { ...profile, modelId: 'another-model' },
      threadIds: ['one'],
    })
  ).toEqual({ embedded: 0, errored: 0, rows: 2 });

  // A later vector for the row clears its failure.
  expect(
    await f.port.putStateSearchVectors({ profile, rows: [{ ...key(first), vector: axis(1) }] })
  ).toEqual({ failed: 0, stale: 0, stored: 1 });
  expect(await f.port.searchStateCoverage({ profile, threadIds: ['one'] })).toEqual({
    embedded: 2,
    errored: 0,
    rows: 2,
  });
});
