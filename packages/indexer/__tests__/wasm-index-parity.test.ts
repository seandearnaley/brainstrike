import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  asBetterSqlite3,
  SqliteWasmDatabase,
} from '@brainstrike/web-state-store/sqlite-wasm-database';
import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { binaryVectorEngine } from '../src/binary-vector-engine.js';
import { openDesktopIndex, openDesktopIndexReader } from '../src/desktop-index-connection.js';
import { IndexReader, IndexWriter } from '../src/store.js';

const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const rootIds = ['root-a', 'root-b'];
const words = [
  'sqlite',
  'index',
  'writer',
  'browser',
  'vector',
  'search',
  'chunk',
  'thread',
  'tapestry',
  'lease',
  'epoch',
  'trigram',
  'cosine',
  'hamming',
  'canvas',
  'origin',
];

let sqlite3: Sqlite3Static;
const cleanup: (() => void)[] = [];

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) {
    dispose();
  }
});

interface OpenIndex {
  readonly reader: IndexReader;
  readonly writer: IndexWriter;
}

/** Desktop: its own file, better-sqlite3 with sqlite-vec, and a separate read-only reader connection. */
function desktopIndex(): OpenIndex {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-index-parity-'));
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'vector-configured', profile },
    rootIds,
  } as const;
  const writer = new IndexWriter(options, openDesktopIndex(options));
  const reader = new IndexReader(options, openDesktopIndexReader(options));
  cleanup.push(() => {
    reader.db.close();
    writer.close();
    rmSync(directory, { force: true, recursive: true });
  });
  return { reader, writer };
}

let webIndexes = 0;

/**
 * The browser writer's shape: sqlite-wasm through the adapter, the binary
 * vector engine, EXCLUSIVE locking as the OPFS pool requires, and the reader
 * on the writer's own connection, since an EXCLUSIVE database has no second one.
 */
function webIndex(): OpenIndex {
  const file = `/index-parity-${++webIndexes}.sqlite`;
  const connection = new SqliteWasmDatabase(sqlite3, new sqlite3.oo1.DB(file, 'c'), file);
  const db = asBetterSqlite3(connection);
  db.pragma('page_size = 4096');
  db.pragma('locking_mode = EXCLUSIVE');
  const options = {
    dbPath: file,
    embedding: { indexMode: 'vector-configured', profile },
    rootIds,
  } as const;
  const writer = new IndexWriter(options, {
    db,
    engine: binaryVectorEngine,
    fresh: true,
    owner: { pid: 1, writerThreadId: 0 },
  });
  const reader = new IndexReader(options, { db: writer.db, engine: binaryVectorEngine });
  cleanup.push(() => writer.close());
  return { reader, writer };
}

/** A deterministic generator, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A unit vector derived from a chunk's id, the same on both sides. */
function vectorFor(id: string): number[] {
  let seed = 0;
  for (const char of id) {
    seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
  }
  const next = random(seed);
  return Array.from({ length: profile.dimensions }, () => next() * 2 - 1);
}

function content(seed: number, lines: number): string {
  const next = random(seed);
  return Array.from({ length: lines }, () =>
    Array.from({ length: 6 }, () => words[Math.floor(next() * words.length)]).join(' ')
  ).join('\n');
}

function commit(index: OpenIndex, fileId: string, rootId: string, text: string): unknown {
  const plan = index.reader.prepare({
    chunkLines: 2,
    content: text,
    fileId,
    relativePath: `src/${fileId}.ts`,
    rootId,
  });
  return index.writer.commit({
    embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector: vectorFor(chunkId) })),
    plan,
    profile,
  });
}

/** Everything a caller sees, without the per-store random identity. */
function comparable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry) =>
      key === 'storeId' || key === 'dbPath' ? undefined : entry
    )
  );
}

/** One workload: commits, every search mode, an edit, a removal and coverage. */
function workload(index: OpenIndex): unknown[] {
  const results: unknown[] = [];
  for (let file = 0; file < 24; file++) {
    results.push(commit(index, `file-${file}`, rootIds[file % 2] as string, content(file, 6)));
  }
  const searches = () =>
    [
      ...['sqlite', 'browser vector', 'tapestry lease epoch', 'hamming'].map((text) => ({
        limit: 8,
        mode: 'bm25',
        rootIds,
        text,
      })),
      ...['ite ind', 'osine', 'pestr'].map((text) => ({
        limit: 8,
        mode: 'trigram',
        rootIds,
        text,
      })),
      ...[1, 2, 3].map((seed) => ({
        limit: 8,
        mode: 'vector',
        profile,
        rootIds: [rootIds[seed % 2] as string],
        vector: vectorFor(`query-${seed}`),
      })),
    ].map((request) => index.reader.search(request));
  results.push(searches());
  results.push(commit(index, 'file-3', 'root-b', content(303, 4)));
  results.push(index.writer.remove({ fileId: 'file-4', rootId: 'root-a' }));
  results.push(searches());
  results.push(index.reader.coverage({ rootIds }));
  return results;
}

describe('the derived index on sqlite-wasm', () => {
  it('commits, searches, edits, removes and reports coverage exactly as the desktop index does', () => {
    const desktop = comparable(workload(desktopIndex()));
    const web = comparable(workload(webIndex()));
    expect(web).toEqual(desktop);
    // The workload exercised every search mode with hits.
    const searches = (web as unknown[])[24] as { hits: unknown[] }[];
    expect(searches.every((result) => result.hits.length > 0)).toBe(true);
  });

  it('reopens an existing browser index under the same identity', () => {
    const file = `/index-parity-reopen-${++webIndexes}.sqlite`;
    const open = (fresh: boolean) => {
      const connection = new SqliteWasmDatabase(sqlite3, new sqlite3.oo1.DB(file, 'c'), file);
      const db = asBetterSqlite3(connection);
      db.pragma('locking_mode = EXCLUSIVE');
      return new IndexWriter(
        { dbPath: file, embedding: { indexMode: 'vector-configured', profile }, rootIds },
        { db, engine: binaryVectorEngine, fresh, owner: { pid: 1, writerThreadId: 0 } }
      );
    };
    const first = open(true);
    const storeId = first.identity.storeId;
    first.close();
    const reopened = open(false);
    try {
      expect(reopened.identity.storeId).toBe(storeId);
      expect(reopened.info.vecVersion).toBe('brainstrike-binary-codes-1');
    } finally {
      reopened.close();
    }
  });
});
