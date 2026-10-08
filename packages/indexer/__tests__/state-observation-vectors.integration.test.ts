import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStateStoreIndexer,
  openIndexer,
  type StateObservationPlan,
  type StateObservationSource,
} from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decoder, stateObservationMetadataSchema } from '../src/contracts.js';
import { captureIndex, captureStorage, groupText } from './fixtures/state-observation-native.mjs';
import { observationChunks } from './fixtures/state-observation-schema.mjs';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const profile = {
  dimensions: 8,
  distance: 'cosine',
  dtype: 'fp32',
  modelId: 'deterministic-storage-proof',
  provider: 'local',
  revision: 'a'.repeat(40),
  tokenCap: 256,
} as const;
const vector = [0.125, -0.25, 0.375, -0.5, 0.625, -0.75, 0.875, -1.031_25];
const scope = { resourceId: 'resource', rootId: 'root', threadId: 'one' };
const date = new Date('2026-10-07T01:02:03.000Z');
const query = { limit: 100, profile, scope, vector };
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Live requests are not part of deterministic storage qualification');
    })
  );
});
afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
const source = (
  groupId = 'native-group',
  threadId = 'one',
  text = 'Actual native storage qualification text.'
): StateObservationSource => ({
  groupId,
  observedAt: date.toISOString(),
  range: 'recorded-first-message:recorded-last-message',
  text,
  threadId,
});

async function fixture(nativeScope: 'thread' | 'resource' = 'thread') {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'state-observation-vectors-')));
  const options = {
    dbPath: join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['root', 'foreign-root'],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/state-observation-schema.mjs', import.meta.url).href,
    },
    stateResources: [
      { profile, resourceId: 'resource', rootId: 'root' },
      { profile, resourceId: 'foreign', rootId: 'foreign-root' },
    ],
    stateRoot: root,
  } as const;
  let port = await openIndexer(options, deadlines);
  let store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  await store.append(
    ['one', 'two', 'foreign-thread'].map((threadId) => ({
      event: { content: 'recorded committed text', type: 'text', v: 2 },
      threadId,
    }))
  );
  for (const [threadId, resourceId] of [
    ['one', 'resource'],
    ['two', 'resource'],
    ['foreign-thread', 'foreign'],
  ] as const) {
    const current = await store.memory({ operation: 'read', resourceId });
    await store.memory({
      changes: [
        {
          entity: {
            id: threadId,
            kind: 'thread',
            payload: { id: threadId, metadata: {}, resourceId },
            threadId,
          },
          operation: 'put',
        },
      ],
      expectedRevision: current.revision,
      operation: 'commit',
      resourceId,
    });
  }
  const native = await captureStorage(nativeScope, 'resource', 'one');
  const persist = async () => {
    const rows = await native.records();
    const current = await store.memory({ operation: 'read', resourceId: 'resource' });
    await store.memory({
      changes: rows.map((entity) => ({ entity, operation: 'put' })),
      expectedRevision: current.revision,
      operation: 'commit',
      resourceId: 'resource',
    });
    return rows;
  };
  await native.active(groupText(source().text, source().groupId, 'one', nativeScope), date);
  await persist();
  return {
    close: async () => {
      try {
        await native.close();
        await store.close();
      } finally {
        try {
          await port.destroy();
          for (const file of [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
            expect(existsSync(file)).toBe(false);
          }
        } finally {
          await rm(root, { force: true, recursive: true });
          expect(existsSync(root)).toBe(false);
        }
      }
    },
    native,
    nativeScope,
    options,
    persist,
    get port() {
      return port;
    },
    reopen: async () => {
      await store.close();
      await port.close();
      port = await openIndexer(
        { ...options, embedding: { indexMode: 'open-existing' } },
        deadlines
      );
      store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
    },
    root,
    get store() {
      return store;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const nativeUpsertSchema = Schema.Struct({
  ids: Schema.Array(Schema.String),
  indexName: Schema.String,
  metadata: Schema.Array(stateObservationMetadataSchema),
  vectors: Schema.Array(Schema.Array(Schema.Finite)),
});

async function write(
  f: Fixture,
  observation: StateObservationSource = source(),
  plan?: StateObservationPlan
) {
  const prepared =
    plan ?? (await f.port.prepareStateObservationVectors({ observation, profile, scope }));
  // Real committed witnesses are present before invoking actual native embedding/chunk/ID logic.
  const truth = await f.store.memory({ operation: 'read', resourceId: 'resource' });
  expect(
    prepared.recordIds.every((id) =>
      truth.entities.some((row) => row.kind === 'observation' && row.id === id)
    )
  ).toBe(true);
  const actual = decoder(nativeUpsertSchema)(await captureIndex(observation, 'resource'));
  expect(actual.indexName).toBe('memory_observations_8');
  const segments = actual.ids.map((id, ordinal) => {
    const metadata = actual.metadata[ordinal],
      embedding = actual.vectors[ordinal];
    if (!(metadata && embedding)) {
      throw new Error('Native batch missing metadata/vector');
    }
    expect(metadata).toEqual({
      group_id: observation.groupId,
      range: observation.range,
      resource_id: 'resource',
      text: prepared.chunks[ordinal],
      thread_id: observation.threadId,
      ...(observation.observedAt === undefined ? {} : { observed_at: observation.observedAt }),
    });
    return { id, text: metadata.text, vector: embedding };
  });
  const ids = await f.port.upsertStateObservationVectors({ plan: prepared, segments });
  expect(ids).toEqual(actual.ids);
  return { ids, plan: prepared, segments };
}

async function byteFiles(f: Fixture): Promise<string[]> {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => {
    bytes.writeFloatLE(value, index * 4);
  });
  const found: string[] = [];
  for (const file of [f.options.dbPath, `${f.options.dbPath}-wal`, `${f.options.dbPath}-shm`]) {
    if (existsSync(file) && (await readFile(file)).includes(bytes)) {
      found.push(file);
    }
  }
  return found;
}

for (const nativeScope of ['thread', 'resource'] as const) {
  it(`persists actual native ${nativeScope} observation identities/metadata and reopens SQLite without altering transcript`, async () => {
    const f = await fixture(nativeScope);
    try {
      const transcript = await f.store.read('one');
      const written = await write(f);
      const hits = await f.port.queryStateObservationVectors(query);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        id: written.ids[0],
        metadata: {
          group_id: source().groupId,
          observed_at: date.toISOString(),
          range: source().range,
          resource_id: 'resource',
          text: source().text,
          thread_id: 'one',
        },
        score: 1,
      });
      expect(written.plan.recordIds).not.toContain(written.ids[0]);
      const db = openConnection(f.options.dbPath, { readonly: true });
      try {
        expect(db.prepare('SELECT count(*) FROM state_observation_vectors').pluck().get()).toBe(1);
        expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
        expect(db.prepare('SELECT count(*) FROM state_message_vectors').pluck().get()).toBe(0);
      } finally {
        db.close();
      }
      await f.reopen();
      expect(await f.port.queryStateObservationVectors(query)).toEqual(hits);
      expect(await f.store.read('one')).toEqual(transcript);
      await expect(
        f.port.upsertStateObservationVectors({ plan: written.plan, segments: written.segments })
      ).rejects.toMatchObject({
        code: 'stale-observation-plan',
      });
    } finally {
      await f.close();
    }
  });
}

it('binds exact native whitespace/oversized-token chunks and refuses forged ID/text/count/vector batches atomically', async () => {
  const f = await fixture();
  try {
    const observation = source(
      'long-group',
      'one',
      `leading\t whitespace\n${'x'.repeat(20_000)} trailing`
    );
    await f.native.active(groupText(observation.text, observation.groupId, 'one', 'thread'), date);
    await f.persist();
    const written = await write(f, observation);
    expect(written.plan.chunks).toEqual(observationChunks(observation.text));
    expect(written.plan.chunks.length).toBeGreaterThan(1);
    expect(written.plan.chunks.join(' ')).not.toBe(observation.text);
    const before = await f.port.queryStateObservationVectors(query);
    const first = written.segments[0];
    if (!first) {
      throw new Error('Native segment required');
    }
    for (const segments of [
      written.segments.slice(1),
      [{ ...first, id: 'forged-native-id' }, ...written.segments.slice(1)],
      [{ ...first, text: 'forged chunk' }, ...written.segments.slice(1)],
      [{ ...first, vector: [1] }, ...written.segments.slice(1)],
      [
        { ...first, vector: [Number.POSITIVE_INFINITY, ...vector.slice(1)] },
        ...written.segments.slice(1),
      ],
      [...written.segments].reverse(),
    ]) {
      await expect(
        f.port.upsertStateObservationVectors({ plan: written.plan, segments })
      ).rejects.toThrow();
      expect(await f.port.queryStateObservationVectors(query)).toEqual(before);
    }
    await expect(
      f.port.upsertStateObservationVectors({
        plan: { ...written.plan, chunks: ['forged source'] },
        segments: written.segments,
      })
    ).rejects.toMatchObject({ code: 'stale-observation-plan' });
  } finally {
    await f.close();
  }
});

it('authorizes live owner separately from attributed thread and filters dates/scope before ranking', async () => {
  const f = await fixture('resource');
  try {
    const neighbor = source('neighbor', 'two', 'Same-resource native group.');
    await f.native.active(
      `${groupText(source().text, source().groupId, 'one', 'resource')}\n${groupText(neighbor.text, neighbor.groupId, 'two', 'resource')}`,
      date
    );
    await f.persist();
    const own = await write(f),
      other = await write(f, { ...neighbor, observedAt: '2026-10-07T02:00:00.000Z' });
    expect(
      await f.port.queryStateObservationVectors({ ...query, limit: 1, threadIds: ['two'] })
    ).toMatchObject([{ id: other.ids[0], metadata: { thread_id: 'two' } }]);
    expect(
      await f.port.queryStateObservationVectors({
        ...query,
        limit: 1,
        observedAfter: date.toISOString(),
      })
    ).toMatchObject([{ id: other.ids[0] }]);
    expect(
      await f.port.queryStateObservationVectors({ ...query, observedBefore: date.toISOString() })
    ).toEqual([]);
    expect(
      await f.port.queryStateObservationVectors({
        ...query,
        observedAfter: '2026-10-07T00:00:00.000Z',
        observedBefore: '2026-10-07T02:00:00.000Z',
      })
    ).toMatchObject([{ id: own.ids[0] }]);
    const { observedAt: _date, ...undated } = neighbor;
    await write(f, undated);
    expect(
      await f.port.queryStateObservationVectors({ ...query, observedAfter: date.toISOString() })
    ).toEqual([]);
    for (const request of [
      { ...query, scope: { ...scope, rootId: 'foreign-root' } },
      { ...query, scope: { ...scope, threadId: 'foreign-thread' } },
      { ...query, threadIds: ['foreign-thread'] },
      { ...query, profile: { ...profile, modelId: 'foreign-model' } },
      { ...query, observedAfter: 'not a date' },
    ]) {
      await expect(f.port.queryStateObservationVectors(request)).rejects.toThrow();
    }
    for (const observation of [
      { ...source(), threadId: 'foreign-thread' },
      { ...source(), groupId: 'missing' },
      { ...source(), text: 'forged body' },
      { ...source(), range: 'forged range' },
    ]) {
      await expect(
        f.port.prepareStateObservationVectors({ observation, profile, scope })
      ).rejects.toThrow();
    }
  } finally {
    await f.close();
  }
});

it('keeps concurrent prepared groups independent through actual native chunks and writes', async () => {
  const f = await fixture('resource');
  try {
    const first = source('concurrent-one', 'one', 'First concurrent native group.');
    const second = source('concurrent-two', 'two', 'Second concurrent native group.');
    await f.native.active(
      `${groupText(first.text, first.groupId, 'one', 'resource')}\n${groupText(second.text, second.groupId, 'two', 'resource')}`,
      date
    );
    await f.persist();
    const plans = await Promise.all(
      [first, second].map((observation) =>
        f.port.prepareStateObservationVectors({ observation, profile, scope })
      )
    );
    const firstPlan = plans[0],
      secondPlan = plans[1];
    if (!(firstPlan && secondPlan)) {
      throw new Error('Both plans required');
    }
    const [one, two] = await Promise.all([
      write(f, first, firstPlan),
      write(f, second, secondPlan),
    ]);
    expect(one.ids).not.toEqual(two.ids);
    expect(
      (await f.port.queryStateObservationVectors(query)).map((hit) => hit.metadata.group_id).sort()
    ).toEqual(['concurrent-one', 'concurrent-two']);
  } finally {
    await f.close();
  }
});

it('joins admitted writer/query tails and refuses actual native embedding that retires after purge', async () => {
  const f = await fixture();
  const admitted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let inference: Promise<unknown> | undefined;
  try {
    const plan = await f.port.prepareStateObservationVectors({
      observation: source(),
      profile,
      scope,
    });
    inference = captureIndex(source(), 'resource', {
      admitted: () => admitted.resolve(),
      release: release.promise,
    });
    await admitted.promise;
    const queries = [
      f.port.queryStateObservationVectors(query),
      f.port.queryStateObservationVectors(query),
    ];
    const purge = f.port.purgeStateObservationVectors(scope);
    await Promise.all([...queries, purge]);
    release.resolve();
    const actual = decoder(nativeUpsertSchema)(await inference);
    const segments = actual.ids.map((id, ordinal) => {
      const metadata = actual.metadata[ordinal],
        embedding = actual.vectors[ordinal];
      if (!(metadata && embedding)) {
        throw new Error('Native batch required');
      }
      return { id, text: metadata.text, vector: embedding };
    });
    await expect(f.port.upsertStateObservationVectors({ plan, segments })).rejects.toMatchObject({
      code: 'stale-observation-plan',
    });
    expect(await f.port.queryStateObservationVectors(query)).toEqual([]);
    expect(await byteFiles(f)).toEqual([]);
  } finally {
    release.resolve();
    await inference;
    await f.close();
  }
});

it('refuses a committed shared native group attributed to a foreign resource thread', async () => {
  const f = await fixture('resource');
  try {
    await f.native.active(
      groupText(source().text, source().groupId, 'foreign-thread', 'resource'),
      date
    );
    await f.persist();
    await expect(
      f.port.prepareStateObservationVectors({ observation: source(), profile, scope })
    ).rejects.toMatchObject({ code: 'observation-not-authorized' });
    await expect(f.port.queryStateObservationVectors(query)).rejects.toMatchObject({
      code: 'observation-not-authorized',
    });
  } finally {
    await f.close();
  }
});

it('preserves native buffer activation/reflection history and ignores incidental record timestamps', async () => {
  const f = await fixture();
  try {
    const buffered = source('buffered-group', 'one', 'Actual buffered group text.');
    await f.native.buffered(groupText(buffered.text, buffered.groupId, 'one', 'thread'), date);
    await f.persist();
    const prepared = await f.port.prepareStateObservationVectors({
      observation: { ...buffered, observedAt: '2026-10-08T00:00:00.000Z' },
      profile,
      scope,
    });
    await f.native.activate();
    await f.persist();
    await write(f, prepared.observation, prepared);
    const reflected = source('reflected-group', 'one', 'Actual reflected native group text.');
    await f.native.reflect(groupText(reflected.text, reflected.groupId, 'one', 'thread'));
    await f.persist();
    await write(f, reflected);
    expect(
      (await f.port.queryStateObservationVectors(query)).map((hit) => hit.metadata.group_id).sort()
    ).toEqual(['buffered-group', 'reflected-group']);
    await f.reopen();
    expect(await f.port.queryStateObservationVectors(query)).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it('rejects relational payload mismatch and conflicting native group witnesses without trusting vendor fields', async () => {
  const f = await fixture();
  try {
    await write(f);
    const rows = await f.native.records();
    const record = rows[0];
    if (!record) {
      throw new Error('Native witness required');
    }
    const truth = openConnection(join(f.root, 'state.db'));
    try {
      truth
        .prepare(
          "UPDATE brainstrike_memory_entities SET payload=json_set(payload,'$.resourceId','foreign') WHERE id=?"
        )
        .run(record.id);
      await expect(f.port.queryStateObservationVectors(query)).rejects.toThrow(/binding/);
      truth
        .prepare('UPDATE brainstrike_memory_entities SET payload=? WHERE id=?')
        .run(JSON.stringify(record.payload), record.id);
    } finally {
      truth.close();
    }
    await f.native.reflect(
      groupText('Conflicting persisted body', source().groupId, 'one', 'thread')
    );
    await f.persist();
    await expect(f.port.queryStateObservationVectors(query)).rejects.toMatchObject({
      code: 'observation-not-authorized',
    });
  } finally {
    await f.close();
  }
});

it('excludes missing committed groups before LIMIT and refuses delayed writes after source removal', async () => {
  const f = await fixture('resource');
  try {
    const neighbor = source('neighbor', 'two', 'Retained native group.');
    await f.native.active(
      `${groupText(source().text, source().groupId, 'one', 'resource')}\n${groupText(neighbor.text, neighbor.groupId, 'two', 'resource')}`,
      date
    );
    await f.persist();
    const missing = await write(f);
    const retained = await write(f, neighbor);
    await f.native.active(groupText(neighbor.text, neighbor.groupId, 'two', 'resource'), date);
    await f.persist();
    expect(await f.port.queryStateObservationVectors({ ...query, limit: 1 })).toMatchObject([
      { id: retained.ids[0] },
    ]);
    await expect(
      f.port.upsertStateObservationVectors({ plan: missing.plan, segments: missing.segments })
    ).rejects.toThrow();
    await f.port.purgeStateObservationVectors({ ...scope, threadId: 'one' });
    const db = openConnection(f.options.dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) FROM state_observation_vectors').pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it('persists pinned-reader cleanup failures, fences late work across reopen and physically erases on retry/delete/reset', async () => {
  const f = await fixture('resource');
  let reader: ReturnType<typeof openConnection> | undefined;
  try {
    const neighbor = source('neighbor', 'two', 'Shared native group.');
    await f.native.active(
      `${groupText(source().text, source().groupId, 'one', 'resource')}\n${groupText(neighbor.text, neighbor.groupId, 'two', 'resource')}`,
      date
    );
    await f.persist();
    const late = await write(f);
    await write(f, neighbor);
    expect(await byteFiles(f)).not.toEqual([]);
    reader = openConnection(f.options.dbPath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM state_observation_vectors').get();
    await expect(f.port.purgeStateObservationVectors(scope)).rejects.toThrow(/checkpoint|pinned/);
    await expect(f.port.queryStateObservationVectors(query)).rejects.toMatchObject({
      code: 'message-cleanup-pending',
    });
    reader.exec('COMMIT');
    reader.close();
    reader = undefined;
    await f.reopen();
    await expect(
      f.port.prepareStateObservationVectors({ observation: source(), profile, scope })
    ).rejects.toMatchObject({ code: 'message-cleanup-pending' });
    await f.port.purgeStateObservationVectors({ resourceId: 'resource', rootId: 'root' });
    expect(await byteFiles(f)).toEqual([]);
    await expect(
      f.port.upsertStateObservationVectors({ plan: late.plan, segments: late.segments })
    ).rejects.toMatchObject({
      code: 'stale-observation-plan',
    });
    await write(f);
    await write(f, neighbor);
    await f.store.deleteThread('one');
    expect(await byteFiles(f)).toEqual([]);
    await expect(f.port.queryStateObservationVectors(query)).rejects.toMatchObject({
      code: 'thread-not-authorized',
    });
    expect(
      await f.port.queryStateObservationVectors({ ...query, scope: { ...scope, threadId: 'two' } })
    ).toEqual([]);
    await expect(
      f.port.upsertStateObservationVectors({ plan: late.plan, segments: late.segments })
    ).rejects.toThrow();
    await f.store.reset();
    for (const file of [
      f.options.dbPath,
      `${f.options.dbPath}-wal`,
      `${f.options.dbPath}-shm`,
      join(f.root, 'state.db'),
    ]) {
      expect(existsSync(file)).toBe(false);
    }
  } finally {
    reader?.close();
    await f.close();
  }
});

it('erases all shared OM attribution on actual committed event purge and refuses its late plans', async () => {
  const f = await fixture('resource');
  try {
    const neighbor = source('neighbor', 'two', 'Shared observation erased with committed purge.');
    await f.native.active(
      `${groupText(source().text, source().groupId, 'one', 'resource')}\n${groupText(neighbor.text, neighbor.groupId, 'two', 'resource')}`,
      date
    );
    await f.persist();
    const late = await write(f);
    await write(f, neighbor);
    await f.store.purge('one', 1);
    expect(await byteFiles(f)).toEqual([]);
    await expect(f.port.queryStateObservationVectors(query)).rejects.toMatchObject({
      code: 'thread-not-authorized',
    });
    expect(
      await f.port.queryStateObservationVectors({ ...query, scope: { ...scope, threadId: 'two' } })
    ).toEqual([]);
    await expect(
      f.port.upsertStateObservationVectors({ plan: late.plan, segments: late.segments })
    ).rejects.toThrow();
    expect(
      (await f.store.memory({ operation: 'read', resourceId: 'resource' })).entities.some(
        (row) => row.kind === 'observation'
      )
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it('requires explicit derived rebuild from schema9 while retaining transcript truth and old index bytes', async () => {
  const f = await fixture();
  try {
    await write(f);
    const transcript = await f.store.read('one');
    await f.store.close();
    await f.port.close();
    const db = openConnection(f.options.dbPath);
    db.prepare('UPDATE index_metadata SET schema_version=9').run();
    db.close();
    const before = await readFile(f.options.dbPath);
    await expect(
      openIndexer({ ...f.options, embedding: { indexMode: 'open-existing' } }, deadlines)
    ).rejects.toMatchObject({ code: 'rebuild-required' });
    expect(await readFile(f.options.dbPath)).toEqual(before);
    const restore = openConnection(f.options.dbPath);
    restore.prepare('UPDATE index_metadata SET schema_version=10').run();
    restore.close();
    await f.reopen();
    expect(await f.store.read('one')).toEqual(transcript);
  } finally {
    await f.close();
  }
});
