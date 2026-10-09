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
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { Schema } from 'effect';
import { afterEach, beforeEach, expect, it, type TestContext, vi } from 'vitest';
import { decoder, stateObservationMetadataSchema } from '../src/contracts.js';
import { ObservationLifecycle } from './fixtures/state-observation-lifecycle.js';
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
const owners = new WeakMap<TestContext['task'], ObservationLifecycle>();
function qualification(body: (owner: ObservationLifecycle) => Promise<void>) {
  return (context: TestContext) => {
    const owner = new ObservationLifecycle(context);
    owners.set(context.task, owner);
    return owner.execute(() => body(owner));
  };
}
afterEach(async (context) => {
  const failures: unknown[] = [];
  try {
    await owners.get(context.task)?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    expect(fetch).not.toHaveBeenCalled();
  } catch (error) {
    failures.push(error);
  } finally {
    vi.unstubAllGlobals();
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Observation ownership and fetch verification failed');
  }
}, getAdjustedTimeout('database'));
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

async function fixture(owner: ObservationLifecycle, nativeScope: 'thread' | 'resource' = 'thread') {
  let cleanupPort: Awaited<ReturnType<typeof openIndexer>> | undefined;
  const root = realpathSync(
    await owner.acquire(
      () => mkdtemp(join(tmpdir(), 'state-observation-vectors-')),
      async (root) => {
        await cleanupPort?.destroy();
        const dbPath = join(root, 'index.sqlite');
        for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          expect(existsSync(file)).toBe(false);
        }
        await rm(root, { force: true, recursive: true });
        expect(existsSync(root)).toBe(false);
      },
      { removal: true }
    )
  );
  const options = {
    dbPath: join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['root', 'foreign-root'],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/state-observation-schema.mjs', import.meta.url).href,
    },
    stateResources: [
      { resourceId: 'resource', rootId: 'root' },
      { resourceId: 'foreign', rootId: 'foreign-root' },
    ],
    stateRoot: root,
  } as const;
  const acquirePort = (indexOptions: Parameters<typeof openIndexer>[0]) =>
    owner.acquire(
      () => openIndexer(indexOptions, deadlines),
      (ownedPort) => ownedPort.close(),
      {
        beforePublication: async (ownedPort) => {
          cleanupPort = ownedPort;
        },
      }
    );
  let port = await acquirePort(options);
  let store = await owner.acquire(
    () => StateStore.open(root, { indexer: createStateStoreIndexer(port) }),
    (ownedStore) => ownedStore.close()
  );
  await owner.work(() =>
    store.append(
      ['one', 'two', 'foreign-thread'].map((threadId) => ({
        event: { content: 'recorded committed text', type: 'text', v: 2 },
        threadId,
      }))
    )
  );
  for (const [threadId, resourceId] of [
    ['one', 'resource'],
    ['two', 'resource'],
    ['foreign-thread', 'foreign'],
  ] as const) {
    const current = await owner.work(() => store.memory({ operation: 'read', resourceId }));
    await owner.work(() =>
      store.memory({
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
      })
    );
  }
  const native = await owner.acquire(
    () => captureStorage(nativeScope, 'resource', 'one'),
    (ownedNative) => ownedNative.close()
  );
  const persist = () =>
    owner.work(async () => {
      const rows = await owner.work(() => native.records());
      const current = await owner.work(() =>
        store.memory({ operation: 'read', resourceId: 'resource' })
      );
      await owner.work(() =>
        store.memory({
          changes: rows.map((entity) => ({ entity, operation: 'put' })),
          expectedRevision: current.revision,
          operation: 'commit',
          resourceId: 'resource',
        })
      );
      return rows;
    });
  await owner.work(() =>
    native.active(groupText(source().text, source().groupId, 'one', nativeScope), date)
  );
  await persist();
  return {
    get native() {
      owner.check();
      return native;
    },
    nativeScope,
    openIndex: () => acquirePort({ ...options, embedding: { indexMode: 'open-existing' } }),
    options,
    owner,
    persist,
    get port() {
      owner.check();
      return port;
    },
    reopen: () =>
      owner.work(async () => {
        await owner.closeResource(store);
        await owner.closeResource(port);
        owner.check();
        port = await acquirePort({ ...options, embedding: { indexMode: 'open-existing' } });
        store = await owner.acquire(
          () => StateStore.open(root, { indexer: createStateStoreIndexer(port) }),
          (ownedStore) => ownedStore.close()
        );
      }),
    root,
    get store() {
      owner.check();
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
  const actual = decoder(nativeUpsertSchema)(
    await f.owner.work(() => captureIndex(observation, 'resource'))
  );
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
  it(
    `persists actual native ${nativeScope} observation identities/metadata and reopens SQLite without altering transcript`,
    qualification(async (owner) => {
      const f = await fixture(owner, nativeScope);
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
    }),
    getAdjustedTimeout('integration')
  );
}

it(
  'binds exact native whitespace/oversized-token chunks and refuses forged ID/text/count/vector batches atomically',
  qualification(async (owner) => {
    const f = await fixture(owner);
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
  }),
  getAdjustedTimeout('integration')
);

it(
  'authorizes live owner separately from attributed thread and filters dates/scope before ranking',
  qualification(async (owner) => {
    const f = await fixture(owner, 'resource');
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
    // Another complete profile is its own partition: it never ranks these vectors.
    expect(
      await f.port.queryStateObservationVectors({
        ...query,
        profile: { ...profile, modelId: 'foreign-model' },
      })
    ).toEqual([]);
    for (const request of [
      { ...query, scope: { ...scope, rootId: 'foreign-root' } },
      { ...query, scope: { ...scope, threadId: 'foreign-thread' } },
      { ...query, threadIds: ['foreign-thread'] },
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
  }),
  getAdjustedTimeout('integration')
);

it(
  'keeps concurrent prepared groups independent through actual native chunks and writes',
  qualification(async (owner) => {
    const f = await fixture(owner, 'resource');
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
  }),
  getAdjustedTimeout('integration')
);

it(
  'joins admitted writer/query tails and refuses actual native embedding that retires after purge',
  qualification(async (owner) => {
    const f = await fixture(owner);
    const admitted = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    owner.releaseOnRetirement(() => release.resolve());
    let inference: Promise<unknown> | undefined;
    try {
      const plan = await f.port.prepareStateObservationVectors({
        observation: source(),
        profile,
        scope,
      });
      inference = owner.work(() =>
        captureIndex(source(), 'resource', {
          admitted: () => admitted.resolve(),
          release: release.promise,
        })
      );
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
    }
  }),
  getAdjustedTimeout('integration')
);

it(
  'refuses a committed shared native group attributed to a foreign resource thread',
  qualification(async (owner) => {
    const f = await fixture(owner, 'resource');
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
  }),
  getAdjustedTimeout('integration')
);

it(
  'preserves native buffer activation/reflection history and ignores incidental record timestamps',
  qualification(async (owner) => {
    const f = await fixture(owner);
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
  }),
  getAdjustedTimeout('integration')
);

it(
  'rejects relational payload mismatch and conflicting native group witnesses without trusting vendor fields',
  qualification(async (owner) => {
    const f = await fixture(owner);
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
  }),
  getAdjustedTimeout('integration')
);

it(
  'excludes missing committed groups before LIMIT and refuses delayed writes after source removal',
  qualification(async (owner) => {
    const f = await fixture(owner, 'resource');
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
  }),
  getAdjustedTimeout('integration')
);

it(
  'persists pinned-reader cleanup failures, fences late work across reopen and physically erases on retry/delete/reset',
  qualification(async (owner) => {
    const f = await fixture(owner, 'resource');
    let reader: ReturnType<typeof openConnection> | undefined;
    owner.releaseOnRetirement(() => {
      reader?.close();
      reader = undefined;
    });
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
      const kept = await write(f, neighbor);
      await f.store.deleteThread('one');
      await expect(f.port.queryStateObservationVectors(query)).rejects.toMatchObject({
        code: 'thread-not-authorized',
      });
      // Deleting one thread keeps the other thread's shared group and vector.
      expect(
        await f.port.queryStateObservationVectors({
          ...query,
          scope: { ...scope, threadId: 'two' },
        })
      ).toMatchObject([{ id: kept.ids[0] }]);
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
    }
  }),
  getAdjustedTimeout('integration')
);

it(
  'erases all shared OM attribution on actual committed event purge and refuses its late plans',
  qualification(async (owner) => {
    const f = await fixture(owner, 'resource');
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
  }),
  getAdjustedTimeout('integration')
);

it(
  "deleting one thread keeps the other thread's shared observations and their vectors",
  qualification(async (owner) => {
    const f = await fixture(owner, 'resource');
    const neighbor = source('neighbor', 'two', 'Shared observation kept after the other delete.');
    await f.native.active(
      `${groupText(source().text, source().groupId, 'one', 'resource')}\n${groupText(neighbor.text, neighbor.groupId, 'two', 'resource')}`,
      date
    );
    await f.persist();
    await write(f);
    const retained = await write(f, neighbor);
    await f.store.deleteThread('one');
    // The shared record keeps only the other thread's attributed section.
    const shared = (await f.store.memory({ operation: 'read', resourceId: 'resource' })).entities
      .filter((row) => row.kind === 'observation')
      .map((row) => row.payload['activeObservations']);
    expect(shared).toEqual([groupText(neighbor.text, neighbor.groupId, 'two', 'resource')]);
    // Its vectors survive; the deleted thread's are gone with the thread.
    expect(
      await f.port.queryStateObservationVectors({ ...query, scope: { ...scope, threadId: 'two' } })
    ).toMatchObject([{ id: retained.ids[0] }]);
    await expect(f.port.queryStateObservationVectors(query)).rejects.toMatchObject({
      code: 'thread-not-authorized',
    });
    const db = openConnection(f.options.dbPath, { readonly: true });
    try {
      expect(
        db.prepare('SELECT DISTINCT thread_id FROM state_observation_vectors').pluck().all()
      ).toEqual(['two']);
    } finally {
      db.close();
    }
  }),
  getAdjustedTimeout('integration')
);

it(
  'refuses a counterfeit schema9 label with observation storage while retaining transcript truth and old index bytes',
  qualification(async (owner) => {
    const f = await fixture(owner);
    await write(f);
    const transcript = await f.store.read('one');
    await owner.closeResource(f.store);
    await owner.closeResource(f.port);
    const db = openConnection(f.options.dbPath);
    db.prepare('UPDATE index_metadata SET schema_version=9').run();
    db.close();
    const before = await readFile(f.options.dbPath);
    await expect(f.openIndex()).rejects.toMatchObject({ code: 'rebuild-required' });
    expect(await readFile(f.options.dbPath)).toEqual(before);
    const restore = openConnection(f.options.dbPath);
    restore.prepare('UPDATE index_metadata SET schema_version=10').run();
    restore.close();
    await f.reopen();
    expect(await f.store.read('one')).toEqual(transcript);
  }),
  getAdjustedTimeout('integration')
);
