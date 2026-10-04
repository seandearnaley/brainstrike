// Recovered M0-A2 i4 cases, qualified through the public native state projection.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { type Mode, type RunEvent, StateStore, UnknownEventError } from '@brainstrike/state-store';
import { expect, it } from 'vitest';
import { schema } from './fixtures/state-schema.mjs';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const producer = new URL('./fixtures/state-schema.mjs', import.meta.url).href;
const v1Text = '{"v":1,"type":"text","text":"alpha from an old build"}';
const v2Text = '{"v":2,"type":"text","content":"beta from this build"}';
const v1Tool = '{"v":1,"type":"tool-result","output":"gamma output"}';
const unknownType = '{"v":2,"type":"hologram","payload":1}';
const unknownVersion = '{"v":3,"type":"text","body":"futurequartz"}';
const events = (bodies: readonly string[]) =>
  bodies.map((body) => ({
    event: JSON.parse(body) as RunEvent,
    threadId: 't1',
  }));

async function fixture(mode: Mode) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-state-schema-')));
  const port = await openIndexer(
    {
      dbPath: path.join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: ['canonical'],
      stateProjection: { mode, module: producer },
      stateRoot: root,
    },
    deadlines
  );
  const indexer = createStateStoreIndexer(port);
  const store = await StateStore.open(root, { indexer });
  return {
    close: async () => {
      try {
        await store.close();
      } finally {
        try {
          await port.close();
        } finally {
          await rm(root, { force: true, recursive: true });
        }
      }
    },
    indexer,
    port,
    root,
    store,
  };
}

it('mixed versions catch up and rebuild using current shapes without rewriting truth or canonical data', async () => {
  const f = await fixture('dev');
  try {
    const plan = await f.port.prepareFile({
      chunkLines: 1,
      content: 'canonical evidence\n',
      fileId: 'kept',
      relativePath: 'kept.txt',
      rootId: 'canonical',
    });
    await f.port.commitTextFile({ plan });
    const identity = await f.port.info();
    await f.store.append(events([v1Text, v2Text, v1Tool, v1Text.replace('alpha', 'delta')]));
    const before = (await f.store.read('t1')).map((row) => row.raw);
    expect(await f.store.readEvents('t1', schema, 'dev')).toEqual([
      { content: 'alpha from an old build', seq: 1, type: 'text', v: 2 },
      { content: 'beta from this build', seq: 2, type: 'text', v: 2 },
      { output: 'gamma output', seq: 3, type: 'tool-result', v: 2 },
      { content: 'delta from an old build', seq: 4, type: 'text', v: 2 },
    ]);
    expect(before[0]).toBe(`{"seq":1,${v1Text.slice(1)}`);
    await f.indexer.catchUp(['t1']);
    expect(await f.indexer.match('t1', 'alpha')).toEqual([1]);
    await f.indexer.rebuild('t1');
    expect(await f.indexer.stats('t1')).toEqual({ cursor: 4, docs: 4, gaps: [] });
    expect(await f.indexer.match('t1', 'old')).toEqual([1, 4]);
    expect((await f.store.read('t1')).map((row) => row.raw)).toEqual(before);
    const found = await f.port.search({
      limit: 10,
      mode: 'bm25',
      rootIds: ['canonical'],
      text: 'evidence',
    });
    expect(found.hits.map((hit) => hit.fileId)).toEqual(['kept']);
    expect(found.storeId).toBe(identity.storeId);
    expect(found.embedding).toEqual(identity.embedding);
    expect(await f.indexer.health()).toEqual({ indexerErrors: [] });
  } finally {
    await f.close();
  }
});

it('dev unknowns reject both the reader and background indexer and surface through foundation health', async () => {
  const f = await fixture('dev');
  try {
    let observed: Promise<unknown> | undefined;
    await f.store.append(events([v2Text, unknownType]), () => {
      observed = f.indexer.catchUp(['t1']).then(
        () => {
          throw new Error('Unknown committed event was accepted');
        },
        (error: unknown) => error
      );
    });
    await expect(f.store.readEvents('t1', schema, 'dev')).rejects.toThrow(UnknownEventError);
    expect(await observed).toBeInstanceOf(Error);
    expect(String(await observed)).toContain('unknown event type "hologram"');
    expect((await f.indexer.health()).indexerErrors.join('\n')).toContain(
      'UnknownEventError: event seq 2: unknown event type "hologram"'
    );
    expect(await f.indexer.stats('t1')).toEqual({ cursor: 0, docs: 0, gaps: [] });
  } finally {
    await f.close();
  }
});

it('prod unknowns stay visible in place with exact derived gap rows and no searchable unknown payload', async () => {
  const f = await fixture('prod');
  try {
    await f.store.append(events([v2Text, unknownType, unknownVersion, v1Text]));
    const before = (await f.store.read('t1')).map((row) => row.raw);
    const decoded = await f.store.readEvents('t1', schema, 'prod');
    expect(decoded.map((event) => event.type)).toEqual([
      'text',
      'unreadable',
      'unreadable',
      'text',
    ]);
    expect(decoded[1]).toMatchObject({ reason: 'unknown event type "hologram"', seq: 2 });
    expect(decoded[2]).toMatchObject({ reason: 'unknown event version 3', seq: 3 });
    expect(f.store.health().visibleErrors.map((event) => event.seq)).toEqual([2, 3]);
    await f.indexer.catchUp(['t1']);
    const stats = {
      cursor: 4,
      docs: 2,
      gaps: [
        { from: 2, reason: 'unknown event type "hologram"', to: 2 },
        { from: 3, reason: 'unknown event version 3', to: 3 },
      ],
    };
    expect(await f.indexer.stats('t1')).toEqual(stats);
    expect(await f.indexer.match('t1', 'futurequartz')).toEqual([]);
    expect(await f.indexer.match('t1', 'hologram')).toEqual([]);
    await f.indexer.rebuild('t1');
    expect(await f.indexer.stats('t1')).toEqual(stats);
    expect((await f.store.read('t1')).map((row) => row.raw)).toEqual(before);
    expect(await f.indexer.health()).toEqual({ indexerErrors: [] });
  } finally {
    await f.close();
  }
});
