import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { createStateStoreIndexer, openIndexer, type StateMessagePlan } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { StateStore, type StateStoreHooks } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { decoder } from '../src/contracts.js';

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
const message = (threadId: string, seq: number) => ({
  messageId: JSON.stringify([threadId, seq]),
  seq,
});

async function fixture(hooks: StateStoreHooks = {}) {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'state-message-vectors-')));
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['root', 'other-root'],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/state-message-schema.mjs', import.meta.url).href,
    },
    stateResources: [
      { profile, resourceId: 'resource', rootId: 'root' },
      { profile, resourceId: 'foreign', rootId: 'other-root' },
    ],
    stateRoot: root,
  } as const;
  let port = await openIndexer(options, deadlines);
  let store = await StateStore.open(root, { hooks, indexer: createStateStoreIndexer(port) });
  await store.append([
    { event: { content: 'recorded committed text', type: 'text', v: 2 }, threadId: 'one' },
    { event: { content: 'retained neighbor', type: 'text', v: 2 }, threadId: 'one' },
    { event: { content: 'same resource other thread', type: 'text', v: 2 }, threadId: 'two' },
    {
      event: { content: 'private foreign resource', type: 'text', v: 2 },
      threadId: 'foreign-thread',
    },
  ]);
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
    options,
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
async function prepare(f: Fixture, seq = 1, threadId = 'one'): Promise<StateMessagePlan> {
  return f.port.prepareStateMessageVectors({
    messages: [message(threadId, seq)],
    profile,
    scope: { ...scope, threadId },
  });
}
async function write(
  f: Fixture,
  seq = 1,
  vectors: readonly (readonly number[])[] = [vector],
  threadId = 'one'
) {
  const plan = await prepare(f, seq, threadId);
  return f.port.upsertStateMessageVectors({
    embeddings: [{ messageId: message(threadId, seq).messageId, vectors }],
    plan,
  });
}
const query = { limit: 10, profile, scope, vector };

async function byteFiles(f: Pick<Fixture, 'root'>): Promise<string[]> {
  const emb = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => {
    emb.writeFloatLE(value, index * 4);
  });
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/vector-byte-files.mjs', import.meta.url))],
      { encoding: 'utf8', timeout: 5000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const value: unknown = JSON.parse(stdout);
          if (!(Array.isArray(value) && value.every((item: unknown) => typeof item === 'string'))) {
            throw new Error('Invalid byte scan');
          }
          resolve(value);
        } catch (cause) {
          reject(cause);
        }
      }
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(JSON.stringify({ needle: emb.toString('base64'), root: f.root }));
  });
}

it('persists ordered segments under canonical message IDs and reopens with identical authorized scores', async () => {
  const f = await fixture();
  try {
    expect(await write(f, 1, [vector, vector.map((value) => -value)])).toEqual([
      { ...message('one', 1), segmentOrdinal: 0 },
      { ...message('one', 1), segmentOrdinal: 1 },
    ]);
    await write(f, 1, [vector], 'two');
    const before = await f.port.queryStateMessageVectors(query);
    expect(before).toHaveLength(3);
    expect(before[0]).toMatchObject({
      ...message('one', 1),
      score: 1,
      segmentOrdinal: 0,
      threadId: 'one',
    });
    expect(before[2]?.score).toBeCloseTo(-1);
    expect(await f.port.queryStateMessageVectors({ ...query, threadIds: [] })).toEqual([]);
    const db = openConnection(f.options.dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) FROM state_message_vectors').pluck().get()).toBe(3);
    } finally {
      db.close();
    }
    const retired = await prepare(f);
    await f.reopen();
    expect(await f.port.queryStateMessageVectors(query)).toEqual(before);
    await expect(
      f.port.upsertStateMessageVectors({
        embeddings: [{ messageId: message('one', 1).messageId, vectors: [vector] }],
        plan: retired,
      })
    ).rejects.toMatchObject({ code: 'stale-message-plan' });
    await write(f, 1, [vector]);
    expect(await f.port.queryStateMessageVectors({ ...query, threadIds: ['one'] })).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('rejects adversarial Root/resource/thread/message selection before ranking or writes', async () => {
  const f = await fixture();
  try {
    await write(f);
    for (const foreignScope of [
      { ...scope, rootId: 'absent' },
      { ...scope, resourceId: 'foreign' },
      { ...scope, threadId: 'foreign-thread' },
      { ...scope, rootId: 'other-root' },
    ]) {
      await expect(
        f.port.prepareStateMessageVectors({
          messages: [message('one', 1)],
          profile,
          scope: foreignScope,
        })
      ).rejects.toThrow(/authorized|resource|Root/);
      await expect(
        f.port.queryStateMessageVectors({ ...query, scope: foreignScope })
      ).rejects.toThrow(/authorized|resource|Root/);
    }
    await expect(
      f.port.queryStateMessageVectors({ ...query, limit: 1, threadIds: ['one', 'foreign-thread'] })
    ).rejects.toMatchObject({ code: 'thread-not-authorized' });
    for (const identity of [
      { messageId: 'invented-vendor-id', seq: 1 },
      message('two', 1),
      message('one', 99),
    ]) {
      await expect(
        f.port.prepareStateMessageVectors({ messages: [identity], profile, scope })
      ).rejects.toMatchObject({ code: 'message-not-authorized' });
    }
    expect(await f.port.queryStateMessageVectors(query)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('rejects incomplete profiles and finite/dimension/Float32-invalid batches atomically', async () => {
  const f = await fixture();
  try {
    await write(f);
    const plan = await prepare(f);
    for (const invalid of [
      [Number.NaN, ...vector.slice(1)],
      [Number.POSITIVE_INFINITY, ...vector.slice(1)],
      [1e100, ...vector.slice(1)],
      vector.slice(1),
      vector.map(() => 0),
    ]) {
      await expect(
        f.port.upsertStateMessageVectors({
          embeddings: [{ messageId: message('one', 1).messageId, vectors: [invalid] }],
          plan,
        })
      ).rejects.toThrow();
    }
    await expect(f.port.upsertStateMessageVectors({ embeddings: [], plan })).rejects.toThrow(
      /exactly once/
    );
    await expect(
      f.port.upsertStateMessageVectors({
        embeddings: [{ messageId: 'forged', vectors: [vector] }],
        plan,
      })
    ).rejects.toThrow(/exactly once/);
    await expect(
      f.port.prepareStateMessageVectors({
        messages: [message('one', 1)],
        profile: { ...profile, revision: undefined },
        scope,
      })
    ).rejects.toThrow(/complete/);
    await expect(
      f.port.prepareStateMessageVectors({
        messages: [message('one', 1)],
        profile: { ...profile, distance: 'l2' },
        scope,
      })
    ).rejects.toThrow(/cosine/);
    const batch = await f.port.prepareStateMessageVectors({
      messages: [message('one', 1), message('one', 2)],
      profile,
      scope,
    });
    await expect(
      f.port.upsertStateMessageVectors({
        embeddings: [
          { messageId: message('one', 1).messageId, vectors: [vector] },
          { messageId: message('one', 2).messageId, vectors: [vector.slice(1)] },
        ],
        plan: batch,
      })
    ).rejects.toThrow(/dimensions/);
    expect(await f.port.queryStateMessageVectors(query)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('truth purge removes vector bytes and refuses inference admitted before or after purged truth', async () => {
  const f = await fixture();
  try {
    await write(f);
    await write(f, 2, [vector.map((value) => -value)]);
    const plan = await prepare(f);
    expect((await byteFiles(f)).length).toBeGreaterThan(0);
    await f.store.purge('one', 1);
    await expect(
      f.port.upsertStateMessageVectors({
        embeddings: [{ messageId: message('one', 1).messageId, vectors: [vector] }],
        plan,
      })
    ).rejects.toThrow();
    await expect(prepare(f)).rejects.toMatchObject({ code: 'thread-not-authorized' });
    await expect(f.port.queryStateMessageVectors(query)).rejects.toMatchObject({
      code: 'thread-not-authorized',
    });
    // StateStore strict purge retires Memory metadata for the affected resource.
    // A fresh host binding can still recall the unpurged committed neighbor.
    const current = await f.store.memory({ operation: 'read', resourceId: scope.resourceId });
    await f.store.memory({
      changes: [
        {
          entity: {
            id: scope.threadId,
            kind: 'thread',
            payload: { id: scope.threadId, metadata: {}, resourceId: scope.resourceId },
            threadId: scope.threadId,
          },
          operation: 'put',
        },
      ],
      expectedRevision: current.revision,
      operation: 'commit',
      resourceId: scope.resourceId,
    });
    await expect(prepare(f)).rejects.toMatchObject({ code: 'message-not-authorized' });
    expect(await byteFiles(f)).toEqual([]);
    expect(await f.port.queryStateMessageVectors(query)).toEqual([
      expect.objectContaining(message('one', 2)),
    ]);
    await f.reopen();
    expect(await byteFiles(f)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('purge joins admitted vector/query work, fences delayed inference, and retains pinned-reader failures until retry', async () => {
  const f = await fixture();
  let reader: ReturnType<typeof openConnection> | undefined;
  try {
    await write(f);
    const plan = await prepare(f);
    reader = openConnection(f.options.dbPath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM state_message_vectors').get();
    const admitted = f.port.queryStateMessageVectors(query);
    await expect(f.port.purgeStateMessageVectors(scope)).rejects.toThrow(/checkpoint|pinned/);
    expect(await admitted).toHaveLength(1);
    await expect(prepare(f)).rejects.toMatchObject({ code: 'message-cleanup-pending' });
    expect((await f.port.stateHealth()).indexerErrors.some((error) => /pinned/.test(error))).toBe(
      true
    );
    await f.reopen();
    await expect(prepare(f)).rejects.toMatchObject({ code: 'message-cleanup-pending' });
    reader.exec('COMMIT');
    reader.close();
    reader = undefined;
    expect(await f.port.purgeStateMessageVectors(scope)).toBe(false);
    expect(await byteFiles(f)).toEqual([]);
    await expect(
      f.port.upsertStateMessageVectors({
        embeddings: [{ messageId: message('one', 1).messageId, vectors: [vector] }],
        plan,
      })
    ).rejects.toMatchObject({ code: 'stale-message-plan' });
    expect(await f.port.queryStateMessageVectors(query)).toEqual([]);
    await write(f);
    expect(await f.port.queryStateMessageVectors(query)).toHaveLength(1);
  } finally {
    reader?.close();
    await f.close();
  }
});

it('reindex, rebuild, thread retirement and reset erase through the existing joined owner', async () => {
  const f = await fixture();
  try {
    await write(f);
    let plan = await prepare(f);
    await f.port.reindexState('one', 1);
    expect(await byteFiles(f)).toEqual([]);
    await expect(
      f.port.upsertStateMessageVectors({
        embeddings: [{ messageId: message('one', 1).messageId, vectors: [vector] }],
        plan,
      })
    ).rejects.toMatchObject({ code: 'stale-message-plan' });
    await write(f);
    await f.port.rebuildState('one');
    expect(await byteFiles(f)).toEqual([]);
    await write(f);
    plan = await prepare(f);
    await f.store.deleteThread('one');
    expect(await byteFiles(f)).toEqual([]);
    await expect(f.port.queryStateMessageVectors(query)).rejects.toMatchObject({
      code: 'thread-not-authorized',
    });
    await expect(
      f.port.upsertStateMessageVectors({
        embeddings: [{ messageId: message('one', 1).messageId, vectors: [vector] }],
        plan,
      })
    ).rejects.toThrow();
    await write(f, 1, [vector], 'two');
    await f.store.reset();
    for (const file of [
      f.options.dbPath,
      `${f.options.dbPath}-wal`,
      `${f.options.dbPath}-shm`,
      path.join(f.root, 'state.db'),
    ]) {
      expect(existsSync(file)).toBe(false);
    }
    await expect(f.port.queryStateMessageVectors(query)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it('refuses schema8 and changed acquired resource grants while preserving files and transcript truth', async () => {
  const f = await fixture();
  try {
    await write(f);
    await f.store.close();
    await f.port.close();
    const db = openConnection(f.options.dbPath);
    db.prepare('UPDATE index_metadata SET schema_version=8').run();
    db.close();
    const bytes = await readFile(f.options.dbPath);
    await expect(
      openIndexer({ ...f.options, embedding: { indexMode: 'open-existing' } }, deadlines)
    ).rejects.toMatchObject({ code: 'rebuild-required' });
    expect(await readFile(f.options.dbPath)).toEqual(bytes);
    const restore = openConnection(f.options.dbPath);
    restore.prepare('UPDATE index_metadata SET schema_version=10').run();
    restore.close();
    await expect(
      openIndexer(
        {
          ...f.options,
          embedding: { indexMode: 'open-existing' },
          stateResources: [{ profile, resourceId: 'resource', rootId: 'other-root' }],
        },
        deadlines
      )
    ).rejects.toMatchObject({ code: 'rebuild-required' });
    await f.reopen();
    expect(await f.port.queryStateMessageVectors(query)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('excludes purged truth before ranking when an interrupted purge leaves the old derived vector', async () => {
  const interrupted = new Error('Recorded purge interruption after committed truth');
  const f = await fixture({
    purgeAfterTruth: () => {
      throw interrupted;
    },
  });
  try {
    await write(f);
    await write(f, 2, [vector.map((value) => -value)]);
    const before = await f.port.queryStateMessageVectors({
      ...query,
      limit: 1,
      threadIds: ['one'],
    });
    expect(before[0]?.messageId).toBe(message('one', 1).messageId);
    await expect(f.store.purge('one', 1)).rejects.toBe(interrupted);
    await expect(f.port.queryStateMessageVectors(query)).rejects.toMatchObject({
      code: 'thread-not-authorized',
    });
    const current = await f.store.memory({ operation: 'read', resourceId: scope.resourceId });
    await f.store.memory({
      changes: [
        {
          entity: {
            id: scope.threadId,
            kind: 'thread',
            payload: { id: scope.threadId, metadata: {}, resourceId: scope.resourceId },
            threadId: scope.threadId,
          },
          operation: 'put',
        },
      ],
      expectedRevision: current.revision,
      operation: 'commit',
      resourceId: scope.resourceId,
    });

    // The higher-scoring stale derived row must never consume the result limit.
    const after = await f.port.queryStateMessageVectors({ ...query, limit: 1, threadIds: ['one'] });
    expect(after).toEqual([expect.objectContaining({ ...message('one', 2), score: -1 })]);
    await expect(prepare(f)).rejects.toMatchObject({ code: 'message-not-authorized' });
    expect((await byteFiles(f)).length).toBeGreaterThan(0);
    await f.reopen();
    expect(await byteFiles(f)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('surfaces CRC and missing-sequence truth failures and never ranks across them', async () => {
  const f = await fixture();
  const db = openConnection(path.join(f.root, 'state.db'));
  try {
    await write(f);
    db.exec(
      "CREATE TEMP TABLE saved_truth AS SELECT * FROM run_events WHERE thread_id='one' AND seq=1"
    );
    db.exec("UPDATE run_events SET crc=crc+1 WHERE thread_id='one' AND seq=1");
    await expect(f.port.queryStateMessageVectors(query)).rejects.toThrow(/CRC|gap/);
    await expect(prepare(f)).rejects.toThrow(/CRC|gap/);
    db.exec("DELETE FROM run_events WHERE thread_id='one' AND seq=1");
    await expect(f.port.queryStateMessageVectors(query)).rejects.toThrow(/CRC|gap/);
    db.exec('INSERT INTO run_events SELECT * FROM saved_truth');
    const source = decoder(Schema.String)(
      db.prepare('SELECT payload FROM saved_truth').pluck().get()
    );
    const changed = JSON.stringify({
      ...decoder(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(source)),
      seq: 99,
    });
    db.prepare("UPDATE run_events SET payload=?,crc=? WHERE thread_id='one' AND seq=1").run(
      changed,
      crc32(Buffer.from(changed))
    );
    await expect(f.port.queryStateMessageVectors(query)).rejects.toThrow(/sequence identity gap/);
    db.exec("DELETE FROM run_events WHERE thread_id='one' AND seq=1");
    db.exec('INSERT INTO run_events SELECT * FROM saved_truth');
    expect(await f.port.queryStateMessageVectors(query)).toHaveLength(1);
    expect(
      (await f.port.stateHealth()).indexerErrors.filter((error) => /CRC|gap/.test(error))
    ).toHaveLength(4);
  } finally {
    db.close();
    await f.close();
  }
});

it('requires the exact acquired selected profile and detects corrupt stored Float32 bytes on reopen', async () => {
  const f = await fixture();
  try {
    await write(f);
    await expect(
      f.port.prepareStateMessageVectors({
        messages: [message('one', 1)],
        profile: { ...profile, modelId: 'foreign-selection' },
        scope,
      })
    ).rejects.toMatchObject({ code: 'profile-not-authorized' });
    await expect(
      f.port.queryStateMessageVectors({
        ...query,
        profile: { ...profile, revision: 'b'.repeat(40) },
      })
    ).rejects.toMatchObject({ code: 'profile-not-authorized' });
    await f.store.close();
    await f.port.close();
    const db = openConnection(f.options.dbPath);
    try {
      const bad = Buffer.alloc(vector.length * 4);
      bad.writeFloatLE(Number.NaN, 0);
      db.prepare('UPDATE state_message_vectors SET emb=?').run(bad);
    } finally {
      db.close();
    }
    await expect(
      openIndexer({ ...f.options, embedding: { indexMode: 'open-existing' } }, deadlines)
    ).rejects.toThrow(/finite/);
  } finally {
    await f.close();
  }
});

it('accepts null text from real Core metadata across SQLite/vector reopen without rewriting unversioned truth', async () => {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'core-message-vectors-')));
  const captured: unknown = JSON.parse(
    await readFile(
      new URL('../../agent-host/__tests__/fixtures/approved-run-log.json', import.meta.url),
      'utf8'
    )
  );
  const rows = decoder(
    Schema.Array(
      Schema.Struct({
        event: Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
        seq: Schema.Int,
        threadId: Schema.String,
      })
    )
  )(captured);
  const threadId = rows[0]?.threadId;
  const started = rows.find((row) => row.event['type'] === 'run.started');
  const accepted = rows.find(
    (row) => row.event['type'] === 'command.accepted' && row.event['method'] === 'run/start'
  );
  if (!(threadId && started) || typeof accepted?.event['commandId'] !== 'string') {
    throw new Error('Recorded Core run is required');
  }
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['root'],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/core-state-projection.mjs', import.meta.url).href,
    },
    stateResources: [{ profile, resourceId: 'resource', rootId: 'root' }],
    stateRoot: root,
  } as const;
  let port = await openIndexer(options, deadlines);
  let store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  try {
    await store.append(
      rows.map((row) => ({
        event: row.event,
        threadId: row.threadId,
      }))
    );
    await store.memory({
      changes: [
        {
          entity: {
            id: threadId,
            kind: 'thread',
            payload: { id: threadId, metadata: {}, resourceId: 'resource' },
            threadId,
          },
          operation: 'put',
        },
      ],
      expectedRevision: 0,
      operation: 'commit',
      resourceId: 'resource',
    });
    const rawBefore = (await store.read(threadId)).map((row) => row.raw);
    expect(rawBefore.map((raw) => JSON.parse(raw)['v'])).toEqual(rows.map(() => undefined));
    const metadata = rows.filter(
      (row) => row.event['type'] === 'command.accepted' || row.event['type'] === 'stream.chunk'
    );
    expect(metadata.length).toBeGreaterThan(0);
    const readMetadata = () => {
      const db = openConnection(options.dbPath, { readonly: true });
      try {
        return decoder(
          Schema.Array(
            Schema.Struct({
              content: Schema.NullOr(Schema.String),
              gap: Schema.NullOr(Schema.String),
              seq: Schema.Int,
            })
          )
        )(
          db
            .prepare(
              'SELECT seq,content,gap_reason AS gap FROM state_event_rows WHERE thread_id=? AND seq IN (SELECT value FROM json_each(?)) ORDER BY seq'
            )
            .all(threadId, JSON.stringify(metadata.map((row) => row.seq)))
        );
      } finally {
        db.close();
      }
    };
    await port.catchUpState([threadId]);
    expect(await port.stateStats(threadId)).toEqual({ cursor: rows.length, docs: 1, gaps: [] });
    const nullMetadata = metadata.map((row) => ({ content: null, gap: null, seq: row.seq }));
    expect(readMetadata()).toEqual(nullMetadata);
    expect(await port.matchState(threadId, 'command')).toEqual([]);
    const currentScope = { ...scope, threadId };
    const plan = await port.prepareStateMessageVectors({
      messages: [{ messageId: accepted.event['commandId'], seq: started.seq }],
      profile,
      scope: currentScope,
    });
    await port.upsertStateMessageVectors({
      embeddings: [{ messageId: accepted.event['commandId'], vectors: [vector] }],
      plan,
    });
    const before = await port.queryStateMessageVectors({ ...query, scope: currentScope });
    expect(before).toEqual([
      expect.objectContaining({
        messageId: accepted.event['commandId'],
        score: 1,
        seq: started.seq,
      }),
    ]);
    await store.close();
    await port.close();
    port = await openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines);
    store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
    expect((await store.read(threadId)).map((row) => row.raw)).toEqual(rawBefore);
    expect(readMetadata()).toEqual(nullMetadata);
    expect(await port.stateStats(threadId)).toEqual({ cursor: rows.length, docs: 1, gaps: [] });
    expect(await port.queryStateMessageVectors({ ...query, scope: currentScope })).toEqual(before);
    await store.purge(threadId, started.seq);
    const db = openConnection(options.dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) FROM state_message_vectors').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
    expect(await byteFiles({ root })).toEqual([]);
  } finally {
    try {
      await store.close();
    } finally {
      try {
        await port.close();
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  }
});
