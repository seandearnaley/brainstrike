/**
 * Shared fixture for the BST-1877 diagnosis integration tests: one migrated, seeded NodeFS data
 * directory is built once per test file; every test copies it, optionally overwrites bytes of one
 * relation's file the way media damage would, reopens the copy with amcheck (the snapshot
 * verifier's own construction) and diagnoses it. PGlite here has data checksums on, so byte damage
 * surfaces as SQLSTATE XX001 on the first read of the page.
 */
import { cp, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, inject } from 'vitest';
import type { CrashSensitiveIndexDb } from '../../src/crash-sensitive-indexes.js';
import {
  diagnoseDatabaseIntegrity,
  type IntegrityDiagnosis,
  type IntegrityDiagnosisOptions,
  planWalksIndex,
} from '../../src/database-integrity-diagnosis.js';
import { createVerificationPglite } from '../../src/pglite-verification-factory.js';
import { findTableDurability } from '../../src/table-durability-registry.js';

export const PAGE = 8192;
export const CHUNKS = 300;
export const PROBE_ROWS = 50;
/** Chunks whose 12 KB of incompressible text is stored out of line, in file_chunks' TOAST table. */
export const TOASTED_CHUNKS = 3;
/** The BIGSERIAL sequence of a precious table (migration 079): owner `brainstrike_mind_ops`. */
export const SEQUENCE = 'brainstrike_mind_ops_seq_seq';
export const SEQUENCE_OWNER = 'brainstrike_mind_ops';
export const BM25_INDEX = 'idx_file_chunks_content_bm25';
export const GIN_INDEX = 'idx_file_chunks_content_tsvector';
export const HNSW_INDEX = 'idx_probe_dim8';
export const PKEY_INDEX = 'file_chunks_pkey';
/** Not in the registry: the "unknown table" case, and the target of heap damage. */
export const UNCLASSIFIED_TABLE = 'zz_unregistered_probe';

export const CLASSIFY: IntegrityDiagnosisOptions['classify'] = findTableDurability;

/** Files key for file_chunks' TOAST relation, whose generated name is not stable. */
export const TOAST_KEY = 'file_chunks toast';
/**
 * A table with a btree index on a column whose values live in its TOAST table (three ~2 KB
 * incompressible columns push a row over the toast threshold, and the first is moved out of line
 * while still fitting a btree entry) and one on an expression over that column.
 */
export const TOAST_OWNER = 'zz_toast_owner';
export const TOAST_OWNER_KEY = `${TOAST_OWNER} toast`;
export const TOAST_OWNER_INDEXES = ['zz_toast_owner_body_idx', 'zz_toast_owner_md5_idx'] as const;

/** Relation name -> file path relative to the data directory (`pg_relation_filepath`). */
export type RelationFiles = Readonly<Record<string, string>>;

export interface Base {
  readonly dir: string;
  readonly fileRecordsOid: string;
  readonly files: RelationFiles;
  readonly secondBtreeIndex: string;
}

let base: Base;
let scratchRoot: string;

export async function overwriteBytes(
  dir: string,
  relationFile: string | undefined,
  offset: number,
  length: number,
  byte = 0x7f
): Promise<void> {
  if (relationFile === undefined) {
    throw new Error('damage target has no recorded file path');
  }
  const handle = await open(path.join(dir, relationFile), 'r+');
  try {
    await handle.write(Buffer.alloc(length, byte), 0, length, offset);
  } finally {
    await handle.close();
  }
}

export async function buildBase(): Promise<Base> {
  const dir = await mkdtemp(path.join(scratchRoot, 'base-'));
  const tarball = await readFile(inject('dbSnapshotPath'));
  const db = await createVerificationPglite({ dataDir: dir, loadDataDir: new Blob([tarball]) });
  try {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ('diag-file', 'diag.md', '/diag.md', 1, $1, $1)`,
      [now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at, embedding)
       SELECT 'chunk-' || g, 'diag-file', g,
              'topic' || (g % 250) || ' ' || md5(g::text) || ' pipeline scheduler',
              'hash-' || g, $2, $2, ('[' || g || ',1,2,3,4,5,6,7]')::vector
       FROM generate_series(1, $1::int) AS g`,
      [CHUNKS, now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
       SELECT 'big-' || g, 'diag-file', 10000 + g,
              (SELECT string_agg(md5(random()::text || k::text), '') FROM generate_series(1, 400) k WHERE g > 0),
              'big-hash-' || g, $1, $1
       FROM generate_series(1, ${TOASTED_CHUNKS}) AS g`,
      [now]
    );
    await db.exec(`
      CREATE INDEX ${HNSW_INDEX} ON file_chunks
        USING hnsw ((embedding::halfvec(8)) halfvec_cosine_ops) WHERE vector_dims(embedding) = 8;
      CREATE TABLE ${UNCLASSIFIED_TABLE} (id int, note text);
      INSERT INTO ${UNCLASSIFIED_TABLE} SELECT g, md5(g::text) FROM generate_series(1, ${PROBE_ROWS}) g;
      CREATE TABLE ${TOAST_OWNER} (id int, body text, pad1 text, pad2 text);
      INSERT INTO ${TOAST_OWNER}
        SELECT g, (SELECT string_agg(md5(g::text || k::text), '') FROM generate_series(1, 62) k WHERE g > 0),
                  (SELECT string_agg(md5(g::text || k::text || 'p'), '') FROM generate_series(1, 62) k WHERE g > 0),
                  (SELECT string_agg(md5(g::text || k::text || 'q'), '') FROM generate_series(1, 62) k WHERE g > 0)
        FROM generate_series(1, 20) g;
      CREATE INDEX ${TOAST_OWNER_INDEXES[0]} ON ${TOAST_OWNER} (body);
      CREATE INDEX ${TOAST_OWNER_INDEXES[1]} ON ${TOAST_OWNER} (md5(body));
    `);
    const second = await db.query<{ name: string }>(
      `SELECT c.relname::text AS name FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
        WHERE i.indrelid = 'file_chunks'::regclass AND NOT i.indisprimary AND am.amname = 'btree'
        ORDER BY c.relname LIMIT 1`
    );
    const secondBtreeIndex = second.rows[0]?.name;
    if (!secondBtreeIndex) {
      throw new Error('file_chunks has no secondary btree index to damage');
    }
    const files: Record<string, string> = {};
    for (const relation of [
      PKEY_INDEX,
      secondBtreeIndex,
      GIN_INDEX,
      BM25_INDEX,
      HNSW_INDEX,
      UNCLASSIFIED_TABLE,
      'file_chunks',
      SEQUENCE,
      TOAST_KEY,
      TOAST_OWNER,
      TOAST_OWNER_KEY,
    ]) {
      // A key ending in " toast" names the TOAST relation of the table before it.
      const toastOf = relation.endsWith(' toast') ? relation.slice(0, -' toast'.length) : null;
      const { rows } = await db.query<{ file: string }>(
        `SELECT pg_relation_filepath(
                  CASE WHEN $2::text IS NOT NULL
                       THEN (SELECT reltoastrelid FROM pg_class WHERE oid = $2::text::regclass)
                       ELSE $1::text::regclass END) AS file`,
        [relation, toastOf]
      );
      const file = rows[0]?.file;
      if (!file) {
        throw new Error(`no file path for ${relation}`);
      }
      files[relation] = file;
    }
    await db.exec('CHECKPOINT');
    const { rows: oids } = await db.query<{ oid: string }>(
      `SELECT 'file_records'::regclass::oid::text AS oid`
    );
    return { dir, fileRecordsOid: oids[0]?.oid ?? '', files, secondBtreeIndex };
  } finally {
    await db.close();
  }
}

/** Copies the base directory, damages the copy, reopens it with amcheck and hands the instance to `run`. */
export async function withDatabase<T>(
  damage: (dir: string, files: RelationFiles) => Promise<void>,
  run: (db: PGlite) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(scratchRoot, 'copy-'));
  await cp(base.dir, dir, { recursive: true });
  await damage(dir, base.files);
  const db = await createVerificationPglite({ dataDir: dir });
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS amcheck');
    return await run(db);
  } finally {
    await db.close();
    await rm(dir, { force: true, recursive: true });
  }
}

export const untouched = async (): Promise<void> => undefined;

export const diagnose = (
  db: CrashSensitiveIndexDb,
  options: Partial<IntegrityDiagnosisOptions> = {}
): Promise<IntegrityDiagnosis> => diagnoseDatabaseIntegrity(db, { classify: CLASSIFY, ...options });

export interface Statement {
  readonly params: readonly unknown[] | undefined;
  readonly sql: string;
}

/** A handle that records every statement the diagnosis issues. */
export function recording(db: PGlite): { handle: CrashSensitiveIndexDb; statements: Statement[] } {
  const statements: Statement[] = [];
  return {
    handle: {
      exec: (sql) => {
        statements.push({ params: undefined, sql });
        return db.exec(sql);
      },
      query: (sql, params) => {
        statements.push({ params, sql });
        return db.query(sql, params);
      },
    },
    statements,
  };
}

/** Plans `statement` the way the probe runs it (sequential scans off) and reports whether it walks `index`. */
export async function statementWalksIndex(
  db: PGlite,
  statement: Statement,
  index: string
): Promise<boolean> {
  await db.exec('BEGIN; SET LOCAL enable_seqscan = off');
  try {
    const { rows } = await db.query<{ 'QUERY PLAN': { Plan: unknown }[] }>(
      `EXPLAIN (FORMAT JSON) ${statement.sql}`,
      statement.params as unknown[] | undefined
    );
    // The production walker: the tests and the probes share one implementation.
    return planWalksIndex(rows[0]?.['QUERY PLAN'][0]?.Plan, index);
  } finally {
    await db.exec('ROLLBACK');
  }
}

/** A handle that throws `error` from every query `when` accepts, and from every exec `execWhen` accepts. */
export function failingStatements(
  db: PGlite,
  error: Error,
  when: (sql: string) => boolean,
  execWhen: (sql: string) => Error | undefined = () => undefined
): CrashSensitiveIndexDb {
  return {
    exec: (sql) => {
      const failure = execWhen(sql);
      return failure ? Promise.reject(failure) : db.exec(sql);
    },
    query: (sql, params) => (when(sql) ? Promise.reject(error) : db.query(sql, params)),
  };
}

/** The hnsw probe's ranked search itself, not the query that first asks whether the index has rows. */
export const HNSW_PROBE = (sql: string) => sql.includes('ORDER BY') && sql.includes('<=>');
export const readError = () => Object.assign(new Error('detoast failed'), { code: 'XX000' });

/** A handle that answers the queries `answer` accepts with the rows it returns; everything else runs for real. */
export function answering(
  db: PGlite,
  answer: (sql: string, params?: unknown[]) => readonly unknown[] | undefined,
  exec: CrashSensitiveIndexDb['exec'] = (sql) => db.exec(sql)
): CrashSensitiveIndexDb {
  return {
    exec,
    query: async (sql, params) => {
      const rows = answer(sql, params);
      return rows ? { rows: rows as never[] } : db.query(sql, params);
    },
  };
}

/** A handle whose `bt_index_check` of `relation` fails with `error`; everything else runs for real. */
export function failingBtreeCheck(
  db: PGlite,
  relation: string,
  error: Error
): CrashSensitiveIndexDb {
  return {
    exec: (sql) => db.exec(sql),
    query: async (sql, params) => {
      if (sql.includes('bt_index_check') && params?.[0] !== undefined) {
        const { rows } = await db.query<{ name: string }>(
          'SELECT $1::oid::regclass::text AS name',
          [String(params[0])]
        );
        if (rows[0]?.name === relation) {
          throw error;
        }
      }
      return db.query(sql, params);
    },
  };
}

/** Registers the base build and cleanup for the calling test file; call once at file scope. */
export function registerDiagnosisFixture(): void {
  beforeAll(async () => {
    scratchRoot = await mkdtemp(path.join(tmpdir(), 'brainstrike-diagnosis-'));
    base = await buildBase();
  }, 60_000);

  afterAll(async () => {
    await rm(scratchRoot, { force: true, recursive: true });
  });
}

export const getBase = (): Base => base;
