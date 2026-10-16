import { openConnection } from '@brainstrike/sqlite-native';
import {
  asBetterSqlite3,
  SqliteWasmDatabase,
} from '@brainstrike/web-state-store/sqlite-wasm-database';
import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BINARY_VECTOR_ENGINE_VERSION, binaryVectorEngine } from '../src/binary-vector-engine.js';
import {
  type CoarseQuery,
  type CoarseVectorEngine,
  SQLITE_VEC_VERSION,
  sqliteVecEngine,
} from '../src/vector-engine.js';

let sqlite3: Sqlite3Static;
const open: Database.Database[] = [];

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

afterEach(() => {
  for (const db of open.splice(0)) {
    db.close();
  }
});

/** Desktop: better-sqlite3 with sqlite-vec loaded. Browser: sqlite-wasm with the binary engine. */
function engines(): { desktop: Database.Database; web: Database.Database } {
  const desktop = openConnection(':memory:');
  const web = asBetterSqlite3(
    new SqliteWasmDatabase(sqlite3, new sqlite3.oo1.DB(':memory:'), ':memory:')
  );
  open.push(desktop, web);
  expect(sqliteVecEngine.attach(desktop)).toBe(SQLITE_VEC_VERSION);
  expect(binaryVectorEngine.attach(web)).toBe(BINARY_VECTOR_ENGINE_VERSION);
  return { desktop, web };
}

/** A deterministic generator, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function vectorBlob(values: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

function vectors(count: number, dimensions: number, seed: number): Uint8Array[] {
  const next = random(seed);
  return Array.from({ length: count }, () =>
    vectorBlob(Array.from({ length: dimensions }, () => next() * 2 - 1))
  );
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** One value; a blob as its bytes, since better-sqlite3 returns a Buffer and sqlite-wasm a Uint8Array. */
function value(db: Database.Database, sql: string, ...params: unknown[]): unknown {
  const result = db
    .prepare(sql)
    .pluck()
    .get(...params);
  return result instanceof Uint8Array ? [...result] : result;
}

describe("the binary engine's vector functions", () => {
  /**
   * Every sqlite-vec build sums fewer than 16 dimensions in order, as the engine does. Above that its
   * Apple Silicon build sums L2 in sixteen fused NEON lanes (and its Intel macOS build in AVX lanes at
   * multiples of 16). Two orders of summing the squared differences agree to within about dims·2⁻²⁴
   * relative once the square root halves the error.
   */
  function expectL2(dimensions: number, actual: number, expected: number) {
    if (dimensions < 16) {
      expect(actual).toBe(expected);
      return;
    }
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(dimensions * 2 ** -24 * expected);
  }

  it("compute sqlite-vec's sign codes, lengths and cosine distances bit for bit, and L2 distances to its summation bound", () => {
    const { desktop, web } = engines();
    let compared = 0;
    for (const dimensions of [8, 384, 1024]) {
      const pool = vectors(60, dimensions, dimensions);
      for (let index = 0; index + 1 < pool.length; index += 2) {
        const [a, b] = [pool[index], pool[index + 1]];
        for (const fn of ['vec_quantize_binary', 'vec_length']) {
          expect(value(web, `SELECT ${fn}(?)`, a)).toEqual(value(desktop, `SELECT ${fn}(?)`, a));
        }
        const cosine = 'SELECT vec_distance_cosine(?,?)';
        expect(value(web, cosine, a, b)).toBe(value(desktop, cosine, a, b));
        const l2 = 'SELECT vec_distance_l2(?,?)';
        expectL2(dimensions, value(web, l2, a, b) as number, value(desktop, l2, a, b) as number);
        compared += 2;
      }
    }
    expect(compared).toBe(180);
  });

  it('refuse the inputs sqlite-vec refuses', () => {
    const { desktop, web } = engines();
    const cases: [string, unknown[]][] = [
      ['SELECT vec_length(?)', [new Uint8Array(6)]],
      ['SELECT vec_distance_cosine(?,?)', [vectorBlob([1, 2, 3, 4]), vectorBlob([1, 2])]],
      ['SELECT vec_distance_l2(?,?)', [vectorBlob([1, 2]), new Uint8Array(3)]],
      ['SELECT vec_quantize_binary(?)', [vectorBlob([1, 2, 3])]],
    ];
    for (const [sql, params] of cases) {
      expect([sql, throws(() => value(web, sql, ...params))]).toEqual([
        sql,
        throws(() => value(desktop, sql, ...params)),
      ]);
      expect(throws(() => value(web, sql, ...params))).toBe(true);
    }
  });
});

describe('coarse code tables', () => {
  it("keep the desktop's vec0 definitions unchanged", () => {
    expect(
      sqliteVecEngine.tableDefinition('vec_chunks', {
        auxiliary: 'emb',
        bits: 384,
        partition: 'root_id',
      })
    ).toBe(
      'CREATE VIRTUAL TABLE vec_chunks USING vec0(id INTEGER PRIMARY KEY,root_id TEXT PARTITION KEY,bin BIT[384],+emb BLOB);'
    );
    expect(
      sqliteVecEngine.tableDefinition('scope_vec_768', {
        bits: 768,
        ifNotExists: true,
        partition: 'profile_hash',
      })
    ).toBe(
      'CREATE VIRTUAL TABLE IF NOT EXISTS scope_vec_768 USING vec0(id INTEGER PRIMARY KEY,profile_hash TEXT PARTITION KEY,bin BIT[768]);'
    );
  });

  /** The same rows in both engines' tables: 3 partitions of 250 vectors. */
  function populated() {
    const dbs = engines();
    const rows = vectors(750, 384, 7).map((emb, index) => ({
      emb,
      id: index + 1,
      root: `root-${index % 3}`,
    }));
    for (const [db, engine] of [
      [dbs.desktop, sqliteVecEngine],
      [dbs.web, binaryVectorEngine],
    ] as const) {
      db.exec(
        engine.tableDefinition('codes', { auxiliary: 'emb', bits: 384, partition: 'root_id' })
      );
      const insert = db.prepare(
        'INSERT INTO codes(id,root_id,bin,emb) VALUES(?,?,vec_quantize_binary(?),?)'
      );
      for (const row of rows) {
        insert.run(BigInt(row.id), row.root, row.emb, row.emb);
      }
    }
    return { ...dbs, rows };
  }

  function candidateIds(
    db: Database.Database,
    engine: CoarseVectorEngine,
    query: CoarseQuery
  ): number[] {
    const nearest = engine.candidates(db, 'codes', query, ['id']);
    return (
      db
        .prepare(nearest.sql)
        .pluck()
        .all(...nearest.params) as (number | bigint)[]
    )
      .map(Number)
      .sort((a, b) => a - b);
  }

  it('choose the same nearest codes as sqlite-vec for rows stored in id order', () => {
    const { desktop, web, rows } = populated();
    for (const [index, queryVector] of vectors(24, 384, 99).entries()) {
      const query = {
        k: 100,
        partition: `root-${index % 3}`,
        partitionColumn: 'root_id',
        vector: queryVector,
      };
      const expected = candidateIds(desktop, sqliteVecEngine, query);
      const actual = candidateIds(web, binaryVectorEngine, query);
      expect(new Set(actual.map((id) => rows[id - 1]?.root))).toEqual(new Set([query.partition]));
      // Codes often tie at the 100th distance. sqlite-vec then takes the higher storage slot, and
      // these rows were stored in id order within one storage chunk, so the highest ids agree.
      expect(actual).toEqual(expected);
    }
  });

  it('differ from sqlite-vec only among codes tied at the k-th distance, whatever the storage order', () => {
    const { desktop, web } = engines();
    const all = vectors(3000, 64, 21).map((emb, index) => ({ emb, id: index + 1 }));
    for (const [db, engine] of [
      [desktop, sqliteVecEngine],
      [web, binaryVectorEngine],
    ] as const) {
      db.exec(engine.tableDefinition('codes', { bits: 64, partition: 'root_id' }));
      const insert = db.prepare(
        'INSERT INTO codes(id,root_id,bin) VALUES(?,?,vec_quantize_binary(?))'
      );
      for (const row of all) {
        insert.run(BigInt(row.id), 'root', row.emb);
      }
      // Re-embedded chunks are deleted and stored again under their ids; more than one storage chunk.
      for (const row of all.filter((candidate) => candidate.id % 97 === 0)) {
        db.prepare('DELETE FROM codes WHERE id=?').run(BigInt(row.id));
        insert.run(BigInt(row.id), 'root', row.emb);
      }
    }
    const code = (db: Database.Database, vector: Uint8Array) =>
      db.prepare('SELECT vec_quantize_binary(?)').pluck().get(vector) as Uint8Array;
    const distance = (left: Uint8Array, right: Uint8Array) =>
      left.reduce((bits, byte, index) => {
        let rest = byte ^ (right[index] as number);
        let count = 0;
        while (rest !== 0) {
          count += rest & 1;
          rest >>= 1;
        }
        return bits + count;
      }, 0);
    const codes = new Map(all.map((row) => [row.id, code(web, row.emb)]));
    let differing = 0;
    for (const queryVector of vectors(12, 64, 77)) {
      const query = { k: 100, partition: 'root', partitionColumn: 'root_id', vector: queryVector };
      const target = code(web, queryVector);
      const distances = (ids: readonly number[]) =>
        ids.map((id) => distance(codes.get(id) as Uint8Array, target)).sort((a, b) => a - b);
      const expected = candidateIds(desktop, sqliteVecEngine, query);
      const actual = candidateIds(web, binaryVectorEngine, query);
      expect(actual).toHaveLength(expected.length);
      // The same distances: any differing id is one equally distant code chosen in place of another.
      expect(distances(actual)).toEqual(distances(expected));
      differing += actual.join() === expected.join() ? 0 : 1;
    }
    // This layout does make the engines choose differently among ties, so the bound above is exercised.
    expect(differing).toBeGreaterThan(0);
  });

  it('rescore candidates to the same ranking as sqlite-vec', () => {
    const { desktop, web } = populated();
    for (const [index, queryVector] of vectors(12, 384, 1234).entries()) {
      const query = {
        k: 100,
        partition: `root-${index % 3}`,
        partitionColumn: 'root_id',
        vector: queryVector,
      };
      const ranked = (db: Database.Database, engine: CoarseVectorEngine) => {
        const nearest = engine.candidates(db, 'codes', query, ['id', 'emb']);
        return (
          db
            .prepare(
              `SELECT id,vec_distance_cosine(emb,?) AS score FROM (${nearest.sql}) ORDER BY score,id`
            )
            .all(queryVector, ...nearest.params) as { id: number | bigint; score: number }[]
        ).map((row) => Number(row.id));
      };
      const expected = ranked(desktop, sqliteVecEngine);
      const actual = ranked(web, binaryVectorEngine);
      // The exact top ten is what search returns; it lies well inside both candidate sets.
      expect(actual.slice(0, 10)).toEqual(expected.slice(0, 10));
    }
  });

  it('restrict candidates to the given ids, as the scoped search does', () => {
    const { desktop, web } = populated();
    const [queryVector] = vectors(1, 384, 5);
    const query = {
      among: { params: [10], sql: 'SELECT id FROM codes WHERE id % ? = 0' },
      k: 100,
      partition: 'root-1',
      partitionColumn: 'root_id',
      vector: queryVector as Uint8Array,
    };
    const expected = candidateIds(desktop, sqliteVecEngine, query);
    const actual = candidateIds(web, binaryVectorEngine, query);
    expect(actual.every((id) => id % 10 === 0)).toBe(true);
    expect(actual).toEqual(expected);
  });
});
