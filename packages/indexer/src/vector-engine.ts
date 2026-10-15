import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { decoder, IndexerError } from './contracts.js';

/** A coarse code table: `id INTEGER PRIMARY KEY`, a partition column, `bin` and an optional auxiliary blob. */
export interface CoarseTableSpec {
  /** A float32 blob column stored beside each code (sqlite-vec's `+column`). */
  readonly auxiliary?: string;
  /** Bits per code: the vector's dimensions, rounded up to a whole byte. */
  readonly bits: number;
  readonly ifNotExists?: boolean;
  readonly partition: string;
}

export interface CoarseQuery {
  /** A subquery yielding the ids the result is restricted to, with its parameters. */
  readonly among?: { readonly params: readonly unknown[]; readonly sql: string };
  readonly k: number;
  /** The partition column's value the result is restricted to. */
  readonly partition: string;
  readonly partitionColumn: string;
  /** The query as a float32 blob; it is quantized to its sign code. */
  readonly vector: Uint8Array;
}

/**
 * The derived store's coarse vector search: each vector's sign code (one bit
 * per dimension) in a code table, the k nearest codes by Hamming distance as
 * candidates, then exact rescoring in SQL with `vec_distance_*` over the
 * stored float32 vectors. Desktop runs it on sqlite-vec's `vec0` tables; the
 * browser, which cannot load sqlite-vec into the official sqlite-wasm build,
 * on ordinary tables scanned in JavaScript (BST-1940).
 *
 * Every other use of a code table (inserts through `vec_quantize_binary`,
 * deletes, joins and counts) is plain SQL on both.
 */
export interface CoarseVectorEngine {
  /**
   * Makes the engine usable on `db` and returns its version, which the
   * derived store records and checks.
   */
  attach(db: Database.Database): string;
  /**
   * A subquery yielding `columns` of the code table's rows whose codes are
   * the `k` nearest the query's by Hamming distance (in no particular order),
   * with its parameters. The caller rescores them exactly in SQL.
   */
  candidates(
    db: Database.Database,
    table: string,
    query: CoarseQuery,
    columns: readonly string[]
  ): CoarseCandidates;
  /** The statement creating a code table. */
  tableDefinition(table: string, spec: CoarseTableSpec): string;
}

export interface CoarseCandidates {
  readonly params: readonly unknown[];
  readonly sql: string;
}

/** The sqlite-vec release the desktop index is built and validated against. */
export const SQLITE_VEC_VERSION = 'v0.1.9';

const integer = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);

/** sqlite-vec's `vec0` virtual tables, loaded into better-sqlite3 by `@brainstrike/sqlite-native`. */
export const sqliteVecEngine: CoarseVectorEngine = {
  attach(db) {
    const version = decoder(Schema.String)(db.prepare('SELECT vec_version()').pluck().get());
    if (version !== SQLITE_VEC_VERSION) {
      throw new IndexerError(
        'rebuild-required',
        `Indexer requires sqlite-vec ${SQLITE_VEC_VERSION}, received ${version}.`
      );
    }
    return version;
  },
  candidates(_db, table, query, columns) {
    const k = decoder(integer)(query.k);
    const among = query.among ? ` AND id IN (${query.among.sql})` : '';
    return {
      params: [query.vector, query.partition, ...(query.among?.params ?? [])],
      sql: `SELECT ${columns.join(',')} FROM ${table} WHERE bin MATCH vec_quantize_binary(?) AND k=${k} AND ${query.partitionColumn}=?${among}`,
    };
  },
  tableDefinition(table, spec) {
    const exists = spec.ifNotExists ? 'IF NOT EXISTS ' : '';
    const auxiliary = spec.auxiliary ? `,+${spec.auxiliary} BLOB` : '';
    return `CREATE VIRTUAL TABLE ${exists}${table} USING vec0(id INTEGER PRIMARY KEY,${spec.partition} TEXT PARTITION KEY,bin BIT[${spec.bits}]${auxiliary});`;
  },
};
