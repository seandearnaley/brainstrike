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
  const reader = new IndexReader(options, {
    db: writer.db,
    engine: binaryVectorEngine,
    owned: false,
  });
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

const requests = [
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
];

interface Hit {
  readonly chunkId: string;
  readonly score: number;
}

interface Search {
  readonly hits: readonly Hit[];
  readonly truncated: boolean;
}

/** A search as requested, and again at the largest limit, so every match is seen. */
interface SearchRun {
  readonly all: Search;
  readonly limited: Search;
  readonly mode: string;
}

/** One workload: commits, every search mode, an edit, a removal and coverage. */
function workload(index: OpenIndex): { results: unknown; searches: SearchRun[] } {
  const results: unknown[] = [];
  const searches: SearchRun[] = [];
  for (let file = 0; file < 24; file++) {
    results.push(commit(index, `file-${file}`, rootIds[file % 2] as string, content(file, 6)));
  }
  const search = () => {
    for (const request of requests) {
      searches.push({
        all: index.reader.search({ ...request, limit: 100 }),
        limited: index.reader.search(request),
        mode: request.mode,
      });
    }
  };
  search();
  results.push(commit(index, 'file-3', 'root-b', content(303, 4)));
  results.push(index.writer.remove({ fileId: 'file-4', rootId: 'root-a' }));
  search();
  results.push(index.reader.coverage({ rootIds }));
  return { results: comparable(results), searches: comparable(searches) as SearchRun[] };
}

/** How many doubles lie between two scores of the same sign. */
function ulps(a: number, b: number): number {
  if (Math.sign(a) !== Math.sign(b)) {
    return Number.POSITIVE_INFINITY;
  }
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, a);
  view.setFloat64(8, b);
  const distance = view.getBigInt64(0) - view.getBigInt64(8);
  return Number(distance < 0n ? -distance : distance);
}

/**
 * The Apple Silicon better-sqlite3 build fuses FTS5 bm25's multiply-adds (clang's default
 * `-ffp-contract=on`); sqlite-wasm, like the other prebuilds, does not. Their bm25 scores then
 * differ by a few ulps, and scores equal in one engine can be a few ulps apart in the other.
 */
const BM25_ULPS = 4;

/**
 * Exact but for bm25 scores, which agree to within BM25_ULPS. Hits that close are tied: their
 * order may differ, and so may which tied hit fills the last slot. The search at the largest
 * limit proves each substitute is a tie on the desktop.
 */
function expectBm25Parity(web: SearchRun, desktop: SearchRun) {
  const { hits: _webHits, ...webRest } = web.limited;
  const { hits: _desktopHits, ...desktopRest } = desktop.limited;
  expect(webRest).toEqual(desktopRest);
  expect(web.all.truncated).toBe(false);
  expect(desktop.all.truncated).toBe(false);
  const desktopHits = new Map(desktop.all.hits.map((hit) => [hit.chunkId, hit]));
  const desktopHit = (chunkId: string) => {
    const hit = desktopHits.get(chunkId);
    expect(hit, `desktop hit ${chunkId}`).toBeDefined();
    return hit as Hit;
  };
  expect(web.all.hits.map((hit) => hit.chunkId).sort()).toEqual([...desktopHits.keys()].sort());
  for (const hit of web.all.hits) {
    const expected = desktopHit(hit.chunkId);
    expect({ ...hit, score: 0 }).toEqual({ ...expected, score: 0 });
    expect(ulps(hit.score, expected.score)).toBeLessThanOrEqual(BM25_ULPS);
  }
  expect(web.limited.hits).toHaveLength(desktop.limited.hits.length);
  web.limited.hits.forEach((hit, slot) => {
    const expected = desktop.limited.hits[slot] as Hit;
    expect(ulps(hit.score, expected.score)).toBeLessThanOrEqual(BM25_ULPS);
    if (hit.chunkId !== expected.chunkId) {
      expect(ulps(desktopHit(hit.chunkId).score, expected.score)).toBeLessThanOrEqual(BM25_ULPS);
    }
  });
}

describe('the derived index on sqlite-wasm', () => {
  it('commits, searches, edits, removes and reports coverage as the desktop index does, bm25 scores to within a few ulps', () => {
    const desktop = workload(desktopIndex());
    const web = workload(webIndex());
    expect(web.results).toEqual(desktop.results);
    expect(web.searches).toHaveLength(desktop.searches.length);
    desktop.searches.forEach((expected, index) => {
      const actual = web.searches[index] as SearchRun;
      if (expected.mode === 'vector') {
        expect(actual).toEqual(expected);
        return;
      }
      expectBm25Parity(actual, expected);
    });
    // The workload exercised every search mode with hits.
    expect(
      web.searches.slice(0, requests.length).every((search) => search.limited.hits.length > 0)
    ).toBe(true);
  });

  it("keeps the writer's connection open when a reader on it is refused", () => {
    const index = webIndex();
    commit(index, 'kept', 'root-a', content(7, 4));
    expect(
      () =>
        new IndexReader(
          { dbPath: '/other.sqlite', embedding: { indexMode: 'text-only' }, rootIds },
          { db: index.writer.db, engine: binaryVectorEngine, owned: false }
        )
    ).toThrow();
    // The writer still writes, and its reader still reads.
    commit(index, 'after', 'root-b', content(8, 4));
    expect(index.reader.coverage({ rootIds }).totals).toMatchObject({ indexedFiles: 2 });
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
