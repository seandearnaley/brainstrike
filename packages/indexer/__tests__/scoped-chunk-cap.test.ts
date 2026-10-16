import {
  asBetterSqlite3,
  SqliteWasmDatabase,
} from '@brainstrike/web-state-store/sqlite-wasm-database';
import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { binaryVectorEngine } from '../src/binary-vector-engine.js';
import { scopedIndexOperations } from '../src/scoped-operations.js';
import { IndexWriter } from '../src/store.js';

// The browser's corpus cap (BST-1940): the scoped store refuses a commit that would leave
// more chunks stored than its cap, and keeps what it already holds.
const rootId = 'root';
const scope = { kind: 'workspace', rootId } as const;
const files = ['a', 'b', 'c'].map((name) => ({
  embeddingSetId: null,
  fileId: `file-${name}`,
  profile: null,
  relativePath: `${name}.ts`,
  rootId,
  sourcePath: `/fsa/${rootId}/${name}.ts`,
}));
/** One chunk a line: `chunkLines: 1`. */
const lines = (count: number, word: string) =>
  Array.from({ length: count }, (_, index) => `export const ${word}${index} = ${index};`).join(
    '\n'
  );

let sqlite3: Sqlite3Static;
const cleanup: (() => void)[] = [];
let opened = 0;
const reopened = new Set<string>();

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) {
    dispose();
  }
});

function index(chunkCap?: number, file = `/chunk-cap-${++opened}.sqlite`) {
  const connection = new SqliteWasmDatabase(sqlite3, new sqlite3.oo1.DB(file, 'c'), file);
  const writer = new IndexWriter(
    {
      ...(chunkCap === undefined ? {} : { chunkCap }),
      dbPath: file,
      embedding: { indexMode: 'text-only' },
      fileBindings: files,
      rootIds: [rootId],
      scopes: [scope],
    },
    {
      db: asBetterSqlite3(connection),
      engine: binaryVectorEngine,
      fresh: !reopened.has(file),
      owner: { pid: 1, writerThreadId: 0 },
    }
  );
  reopened.add(file);
  const ops = scopedIndexOperations(writer);
  const publish = (file: (typeof files)[number], content: string) => {
    const { profile: _profile, ...identity } = file;
    const plan = ops.prepareScopedFile({ snapshot: { ...identity, chunkLines: 1, content } });
    return ops.commitScopedTextFile({ plan });
  };
  const chunks = () =>
    (ops.coverageScope({ scope }) as { counts: { chunks: number } }).counts.chunks;
  cleanup.push(() => writer.close());
  return { chunks, close: () => writer.close(), file, publish };
}

describe('the scoped store with a chunk cap', () => {
  it('refuses a commit past the cap whole, and keeps what it holds', () => {
    const { chunks, publish } = index(3);
    publish(files[0]!, lines(2, 'alpha'));
    expect(chunks()).toBe(2);

    expect(() => publish(files[1]!, lines(2, 'beta'))).toThrow(
      expect.objectContaining({ code: 'corpus-cap', name: 'IndexerError' })
    );
    expect(() => publish(files[1]!, lines(2, 'beta'))).toThrow(
      'The file index holds at most 3 chunks; this file would take it to 4.'
    );
    // The refused file left nothing behind; the first is whole.
    expect(chunks()).toBe(2);

    publish(files[1]!, lines(1, 'beta'));
    expect(chunks()).toBe(3);
  });

  it('admits a republication that keeps the store within the cap', () => {
    const { chunks, publish } = index(3);
    publish(files[0]!, lines(3, 'alpha'));
    // The file's own chunks are replaced, not added to.
    publish(files[0]!, lines(3, 'gamma'));
    expect(chunks()).toBe(3);
    expect(() => publish(files[2]!, lines(1, 'delta'))).toThrow('at most 3 chunks');
  });

  it('lets a store over a cap lowered since it was filled converge down, and grow no further', () => {
    const filled = index();
    filled.publish(files[0]!, lines(3, 'alpha'));
    filled.publish(files[1]!, lines(2, 'beta'));
    filled.close();

    const { chunks, publish } = index(3, filled.file);
    expect(chunks()).toBe(5);
    // A republication that shrinks the store is admitted, though it stays over the cap;
    // growth past the cap is not.
    publish(files[0]!, lines(2, 'alpha'));
    expect(chunks()).toBe(4);
    publish(files[1]!, lines(1, 'beta'));
    expect(chunks()).toBe(3);
    expect(() => publish(files[2]!, lines(1, 'gamma'))).toThrow('at most 3 chunks');
  });

  it('holds any number without a cap, as desktop runs it', () => {
    const { chunks, publish } = index();
    publish(files[0]!, lines(5, 'alpha'));
    publish(files[1]!, lines(5, 'beta'));
    expect(chunks()).toBe(10);
  });
});
