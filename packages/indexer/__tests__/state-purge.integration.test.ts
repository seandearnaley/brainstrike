import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { largeText, StateStore, type StateStoreHooks } from '@brainstrike/state-store';
import { expect, it } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const secret = 'uniquequartzcanary';
function isFileList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((file: unknown) => typeof file === 'string');
}

/** Raw file closes must not release SQLite locks held by the truth writer's other thread. */
function byteFiles(root: string, needle: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let inputFailure: Error | undefined;
    const child = execFile(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/byte-files.mjs', import.meta.url))],
      { encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: 64 * 1024, timeout: 5000 },
      (error, stdout) => {
        const failures: Error[] = [];
        if (error) {
          failures.push(error);
        }
        if (inputFailure) {
          failures.push(inputFailure);
        }
        if (failures.length > 0) {
          reject(new AggregateError(failures, 'Physical byte observation failed'));
          return;
        }
        try {
          const result: unknown = JSON.parse(stdout);
          if (
            typeof result !== 'object' ||
            result === null ||
            !('files' in result) ||
            !isFileList(result.files)
          ) {
            throw new TypeError('Physical byte observation returned an invalid result');
          }
          resolve(result.files);
        } catch (failure: unknown) {
          reject(failure);
        }
      }
    );
    if (!child.stdin) {
      inputFailure = new Error('Physical byte observation has no input pipe');
      child.kill('SIGKILL');
      return;
    }
    child.stdin.on('error', (error: Error) => {
      inputFailure = error;
      child.kill('SIGKILL');
    });
    child.stdin.end(JSON.stringify({ needle, root }));
  });
}

async function fixture(hooks: StateStoreHooks = {}) {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-state-purge-')));
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: [],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/state-schema.mjs', import.meta.url).href,
    },
    stateRoot: root,
  } as const;
  const port = await openIndexer(options, deadlines);
  const indexer = createStateStoreIndexer(port);
  let store = await StateStore.open(root, { hooks, indexer });
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
    options,
    port,
    reopen: async () => {
      await store.close();
      store = await StateStore.open(root, { indexer });
    },
    root,
    get store() {
      return store;
    },
  };
}

function indexed(root: string, text: string): unknown[] {
  const db = openConnection(path.join(root, 'index.sqlite'), { readonly: true });
  try {
    return db
      .prepare('SELECT rowid FROM state_events_fts WHERE state_events_fts MATCH ?')
      .all(text);
  } finally {
    db.close();
  }
}

function vocabulary(root: string, text: string): unknown {
  const db = openConnection(path.join(root, 'index.sqlite'), { readonly: true });
  try {
    db.exec('CREATE VIRTUAL TABLE temp.state_vocab USING fts5vocab(main, state_events_fts, row)');
    return db.prepare('SELECT count(*) FROM temp.state_vocab WHERE term=?').pluck().get(text);
  } finally {
    db.close();
  }
}

async function seed(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const text = largeText(`${secret} ${'durable tool output '.repeat(900)}`);
  if (!text.blob) {
    throw new Error('Fixture must create a real content-addressed blob');
  }
  await f.store.append([
    { event: { content: 'retained neighbor', type: 'text', v: 2 }, threadId: 'one' },
    { blobs: [text.blob], event: { type: 'tool-result', v: 2, ...text.fields }, threadId: 'one' },
  ]);
  await f.indexer.catchUp(['one']);
  expect(indexed(f.root, secret)).toHaveLength(1);
  expect(vocabulary(f.root, secret)).toBe(1);
  expect((await byteFiles(f.root, secret)).some((file) => file.includes('state.db'))).toBe(true);
  expect((await byteFiles(f.root, secret)).some((file) => file.includes('index.sqlite'))).toBe(
    true
  );
  expect(existsSync(path.join(f.root, 'blobs', text.blob.hash))).toBe(true);
  return text.blob.hash;
}

it('production purge removes a committed secret from truth, derived FTS/freelist/WAL and blob before resolving', async () => {
  const f = await fixture();
  try {
    const hash = await seed(f);
    await f.store.purge('one', 2);
    expect(indexed(f.root, secret)).toEqual([]);
    expect(vocabulary(f.root, secret)).toBe(0);
    expect(await byteFiles(f.root, secret)).toEqual([]);
    expect(existsSync(path.join(f.root, 'blobs', hash))).toBe(false);
    expect((await f.store.read('one')).map((row) => row.event.type)).toEqual(['text', 'purged']);
    expect(await f.indexer.gcCheck(['one'], [hash])).toEqual({ [hash]: 0 });
    await f.reopen();
    expect(indexed(f.root, secret)).toEqual([]);
    expect((await f.store.check()).integrity).toBe('ok');
  } finally {
    await f.close();
  }
});

it('a failure after durable truth deletion leaves old FTS until reopen replays the persisted intent', async () => {
  const failure = new Error('Interrupted after committed truth purge');
  const f = await fixture({
    purgeAfterTruth: () => {
      throw failure;
    },
  });
  try {
    const hash = await seed(f);
    await expect(f.store.purge('one', 2)).rejects.toBe(failure);
    expect(indexed(f.root, secret)).toHaveLength(1);
    expect((await f.store.read('one', 2))[0]?.event.type).toBe('purged');
    const truth = openConnection(path.join(f.root, 'state.db'), { readonly: true });
    try {
      expect(truth.prepare('SELECT count(*) FROM purge_intent').pluck().get()).toBe(1);
    } finally {
      truth.close();
    }
    expect(existsSync(path.join(f.root, 'blobs', hash))).toBe(true);
    await f.reopen();
    expect(existsSync(path.join(f.root, 'blobs', hash))).toBe(false);
    expect(indexed(f.root, 'retained')).toHaveLength(1);
    const reopenedTruth = openConnection(path.join(f.root, 'state.db'), { readonly: true });
    try {
      expect(reopenedTruth.prepare('SELECT count(*) FROM purge_intent').pluck().get()).toBe(0);
    } finally {
      reopenedTruth.close();
    }
    expect(await byteFiles(f.root, secret)).toEqual([]);
    expect(indexed(f.root, secret)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('purge without prior catch-up accounts for an earlier same-thread shared reference', async () => {
  const f = await fixture();
  try {
    const output = largeText('shared reference '.repeat(1000));
    if (!output.blob) {
      throw new Error('Fixture must create a blob');
    }
    await f.store.append([
      {
        blobs: [output.blob],
        event: { type: 'tool-result', v: 2, ...output.fields },
        threadId: 'one',
      },
      { event: { type: 'tool-result', v: 2, ...output.fields }, threadId: 'one' },
    ]);
    await f.store.purge('one', 2);
    expect(await f.indexer.gcCheck(['one'], [output.blob.hash])).toEqual({ [output.blob.hash]: 1 });
    expect(existsSync(path.join(f.root, 'blobs', output.blob.hash))).toBe(true);
    await f.store.purge('one', 1);
    expect(existsSync(path.join(f.root, 'blobs', output.blob.hash))).toBe(false);
  } finally {
    await f.close();
  }
});

it('catch-up includes a newly committed second-thread reference before collecting a shared blob', async () => {
  const f = await fixture();
  try {
    const hash = await seed(f);
    const output = largeText(`${secret} ${'durable tool output '.repeat(900)}`);
    await f.store.append([
      { event: { type: 'tool-result', v: 2, ...output.fields }, threadId: 'two' },
    ]);
    await f.store.purge('one', 2);
    expect(existsSync(path.join(f.root, 'blobs', hash))).toBe(true);
    expect(await f.indexer.gcCheck(['one', 'two'], [hash])).toEqual({ [hash]: 1 });
    await f.store.purge('two', 1);
    expect(existsSync(path.join(f.root, 'blobs', hash))).toBe(false);
    expect(await byteFiles(f.root, secret)).toEqual([]);
  } finally {
    await f.close();
  }
});

async function unprojectedPurgeRows(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const output = largeText(`${secret} ${'durable tool output '.repeat(900)}`);
  if (!output.blob) {
    throw new Error('Fixture must create a real content-addressed blob');
  }
  await f.store.append([
    { event: { content: 'retained before', type: 'text', v: 2 }, threadId: 'one' },
    {
      blobs: [output.blob],
      event: { type: 'tool-result', v: 2, ...output.fields },
      threadId: 'one',
    },
    { event: { content: 'retained after', type: 'text', v: 2 }, threadId: 'one' },
  ]);
  const db = openConnection(f.options.dbPath, { readonly: true });
  try {
    expect(db.prepare('SELECT count(*) FROM state_event_rows').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM state_thread_cursors').pluck().get()).toBe(0);
  } finally {
    db.close();
  }
  expect((await f.store.read('one')).map((row) => row.seq)).toEqual([1, 2, 3]);
  expect((await byteFiles(f.root, secret)).length).toBeGreaterThan(0);
  expect(existsSync(path.join(f.root, 'blobs', output.blob.hash))).toBe(true);
  return output.blob.hash;
}

async function assertOrderedPurge(
  f: Awaited<ReturnType<typeof fixture>>,
  hash: string
): Promise<void> {
  expect(indexed(f.root, secret)).toEqual([]);
  expect(vocabulary(f.root, secret)).toBe(0);
  expect(await byteFiles(f.root, secret)).toEqual([]);
  expect(existsSync(path.join(f.root, 'blobs', hash))).toBe(false);
  expect(indexed(f.root, 'retained')).toHaveLength(2);
  const db = openConnection(f.options.dbPath, { readonly: true });
  try {
    expect(db.prepare('SELECT seq FROM state_event_rows ORDER BY seq').pluck().all()).toEqual([
      1, 2, 3,
    ]);
    expect(
      db.prepare('SELECT seq FROM state_thread_cursors WHERE thread_id=?').pluck().get('one')
    ).toBe(3);
    expect(
      db
        .prepare('SELECT count(*) FROM state_event_rows WHERE instr(payload,?)>0')
        .pluck()
        .get(secret)
    ).toBe(0);
    expect(
      db.prepare('SELECT count(*) FROM state_event_blob_refs WHERE hash=?').pluck().get(hash)
    ).toBe(0);
  } finally {
    db.close();
  }
  const rows = await f.store.read('one');
  expect(rows.map((row) => row.event.type)).toEqual(['text', 'purged', 'text']);
  expect(rows[0]?.event['content']).toBe('retained before');
  expect(rows[2]?.event['content']).toBe('retained after');
  expect(JSON.stringify(rows)).not.toContain(secret);
}

it('meaningful catch-up admitted before purge cannot restore a purged event', async () => {
  const f = await fixture();
  try {
    const hash = await unprojectedPurgeRows(f);
    const pass = f.indexer.catchUp(['one']);
    const purge = f.store.purge('one', 2).then(() => assertOrderedPurge(f, hash));
    const outcomes = await Promise.allSettled([pass, purge]);
    const failures: unknown[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        failures.push(outcome.reason);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Both admitted catch-up and purge must settle');
    }
    await f.indexer.catchUp(['one']);
    await assertOrderedPurge(f, hash);
  } finally {
    await f.close();
  }
});

it('meaningful catch-up admitted after truth purge preserves neighbors without resurrecting the secret', async () => {
  let pass: Promise<void> | undefined;
  const f = await fixture({
    purgeAfterTruth: () => {
      pass = f.indexer.catchUp(['one']);
    },
  });
  try {
    const hash = await unprojectedPurgeRows(f);
    await f.store.purge('one', 2).then(() => assertOrderedPurge(f, hash));
    if (!pass) {
      throw new Error('Purge must admit catch-up after its committed truth deletion');
    }
    await pass;
    await f.indexer.catchUp(['one']);
    await assertOrderedPurge(f, hash);
  } finally {
    await f.close();
  }
});

it('a pinned derived reader rejects purge and retains its intent until real checkpoint retry succeeds', async () => {
  const f = await fixture();
  let reader: ReturnType<typeof openConnection> | undefined;
  try {
    await seed(f);
    reader = openConnection(f.options.dbPath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM state_event_rows').get();
    await expect(f.store.purge('one', 2)).rejects.toThrow(/checkpoint|pinned|busy/i);
    const truth = openConnection(path.join(f.root, 'state.db'), { readonly: true });
    try {
      expect(truth.prepare('SELECT count(*) FROM purge_intent').pluck().get()).toBe(1);
    } finally {
      truth.close();
    }
    reader.exec('COMMIT');
    reader.close();
    reader = undefined;
    await f.reopen();
    expect(await byteFiles(f.root, secret)).toEqual([]);
    expect(indexed(f.root, secret)).toEqual([]);
  } finally {
    reader?.close();
    await f.close();
  }
});

it('thread deletion returns and collects real reference rows, and reset joins the real derived owner', async () => {
  const f = await fixture();
  try {
    const hash = await seed(f);
    expect(await f.store.deleteThread('one')).toEqual([hash]);
    expect(await byteFiles(f.root, secret)).toEqual([]);
    await f.store.reset();
    expect(existsSync(f.options.dbPath)).toBe(false);
    expect(existsSync(path.join(f.root, 'state.db'))).toBe(false);
    await expect(f.indexer.catchUp(['one'])).rejects.toThrow();
  } finally {
    await f.close();
  }
});
