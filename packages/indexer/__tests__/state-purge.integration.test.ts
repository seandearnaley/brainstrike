import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { largeText, StateStore, type StateStoreHooks } from '@brainstrike/state-store';
import { expect, it } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const secret = 'uniquequartzcanary';
const byteFiles = (root: string, needle: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => readFileSync(file).includes(Buffer.from(needle)));

async function fixture(hooks: StateStoreHooks = {}) {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-state-purge-')));
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: [],
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
    { event: { content: 'retained neighbor', type: 'text' }, threadId: 'one' },
    { blobs: [text.blob], event: { type: 'tool-result', ...text.fields }, threadId: 'one' },
  ]);
  await f.indexer.catchUp(['one']);
  expect(indexed(f.root, secret)).toHaveLength(1);
  expect(vocabulary(f.root, secret)).toBe(1);
  expect(byteFiles(f.root, secret).some((file) => file.includes('state.db'))).toBe(true);
  expect(byteFiles(f.root, secret).some((file) => file.includes('index.sqlite'))).toBe(true);
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
    expect(byteFiles(f.root, secret)).toEqual([]);
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
    await seed(f);
    await expect(f.store.purge('one', 2)).rejects.toBe(failure);
    expect(indexed(f.root, secret)).toHaveLength(1);
    expect((await f.store.read('one', 2))[0]?.event.type).toBe('purged');
    await f.reopen();
    expect(byteFiles(f.root, secret)).toEqual([]);
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
      { blobs: [output.blob], event: { type: 'tool-result', ...output.fields }, threadId: 'one' },
      { event: { type: 'tool-result', ...output.fields }, threadId: 'one' },
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
    await f.store.append([{ event: { type: 'tool-result', ...output.fields }, threadId: 'two' }]);
    await f.store.purge('one', 2);
    expect(existsSync(path.join(f.root, 'blobs', hash))).toBe(true);
    expect(await f.indexer.gcCheck(['one', 'two'], [hash])).toEqual({ [hash]: 1 });
    await f.store.purge('two', 1);
    expect(existsSync(path.join(f.root, 'blobs', hash))).toBe(false);
    expect(byteFiles(f.root, secret)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('an already queued production catch-up cannot restore a purged event', async () => {
  const f = await fixture();
  try {
    await seed(f);
    const pass = f.indexer.catchUp(['one']);
    const purge = f.store.purge('one', 2);
    await Promise.all([pass, purge]);
    expect(indexed(f.root, secret)).toEqual([]);
    expect(byteFiles(f.root, secret)).toEqual([]);
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
    expect(byteFiles(f.root, secret)).toEqual([]);
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
    expect(byteFiles(f.root, secret)).toEqual([]);
    await f.store.reset();
    expect(existsSync(f.options.dbPath)).toBe(false);
    expect(existsSync(path.join(f.root, 'state.db'))).toBe(false);
    await expect(f.indexer.catchUp(['one'])).rejects.toThrow();
  } finally {
    await f.close();
  }
});
