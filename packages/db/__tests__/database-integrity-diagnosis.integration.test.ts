/**
 * BST-1877 L1: relation-by-relation integrity diagnosis on a real NodeFS PGlite
 * data directory. One migrated, seeded directory is built once; every test
 * copies it, optionally overwrites bytes of one relation's file the way media
 * damage would, reopens the copy with amcheck (the snapshot verifier's own
 * construction) and diagnoses it. PGlite here has data checksums on, so byte
 * damage surfaces as SQLSTATE XX001 on the first read of the page.
 */
import { cp, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { CrashSensitiveIndexDb } from '../src/crash-sensitive-indexes.js';
import {
  diagnoseDatabaseIntegrity,
  type IntegrityDiagnosis,
  type IntegrityDiagnosisOptions,
} from '../src/database-integrity-diagnosis.js';
import { classifyFindingSeverity } from '../src/database-integrity-finding.js';
import { createVerificationPglite } from '../src/pglite-verification-factory.js';
import {
  findTableDurability,
  TABLE_DURABILITY_REGISTRY,
} from '../src/table-durability-registry.js';

const PAGE = 8192;
const CHUNKS = 300;
const PROBE_ROWS = 50;
const BM25_INDEX = 'idx_file_chunks_content_bm25';
const GIN_INDEX = 'idx_file_chunks_content_tsvector';
const HNSW_INDEX = 'idx_probe_dim8';
const PKEY_INDEX = 'file_chunks_pkey';
/** Not in the registry: the "unknown table" case, and the target of heap damage. */
const UNCLASSIFIED_TABLE = 'zz_unregistered_probe';

const CLASSIFY: IntegrityDiagnosisOptions['classify'] = findTableDurability;

/** Relation name -> file path relative to the data directory (`pg_relation_filepath`). */
type RelationFiles = Readonly<Record<string, string>>;

interface Base {
  readonly dir: string;
  readonly files: RelationFiles;
  readonly secondBtreeIndex: string;
}

let base: Base;
let scratchRoot: string;

async function overwriteBytes(
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

async function buildBase(): Promise<Base> {
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
    await db.exec(`
      CREATE INDEX ${HNSW_INDEX} ON file_chunks
        USING hnsw ((embedding::halfvec(8)) halfvec_cosine_ops) WHERE vector_dims(embedding) = 8;
      CREATE TABLE ${UNCLASSIFIED_TABLE} (id int, note text);
      INSERT INTO ${UNCLASSIFIED_TABLE} SELECT g, md5(g::text) FROM generate_series(1, ${PROBE_ROWS}) g;
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
    ]) {
      const { rows } = await db.query<{ file: string }>(
        'SELECT pg_relation_filepath($1::regclass) AS file',
        [relation]
      );
      const file = rows[0]?.file;
      if (!file) {
        throw new Error(`no file path for ${relation}`);
      }
      files[relation] = file;
    }
    await db.exec('CHECKPOINT');
    return { dir, files, secondBtreeIndex };
  } finally {
    await db.close();
  }
}

/** Copies the base directory, damages the copy, reopens it with amcheck and hands the instance to `run`. */
async function withDatabase<T>(
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

const untouched = async (): Promise<void> => undefined;

const diagnose = (
  db: CrashSensitiveIndexDb,
  options: Partial<IntegrityDiagnosisOptions> = {}
): Promise<IntegrityDiagnosis> => diagnoseDatabaseIntegrity(db, { classify: CLASSIFY, ...options });

interface Statement {
  readonly params: readonly unknown[] | undefined;
  readonly sql: string;
}

/** A handle that records every statement the diagnosis issues. */
function recording(db: PGlite): { handle: CrashSensitiveIndexDb; statements: Statement[] } {
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

beforeAll(async () => {
  scratchRoot = await mkdtemp(path.join(tmpdir(), 'brainstrike-diagnosis-'));
  base = await buildBase();
}, 60_000);

afterAll(async () => {
  await rm(scratchRoot, { force: true, recursive: true });
});

describe('a healthy migrated database', () => {
  it('has no findings, and every relation is checked or listed as unchecked', async () => {
    await withDatabase(untouched, async (db) => {
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.findingsTruncated).toBe(false);

      // Control: the relations the diagnosis is meant to cover, counted independently.
      const enumerated = await db.query<{ total: number; schemas: string[] }>(
        `SELECT count(*) FILTER (WHERE n.nspname IN ('public', 'pg_catalog', 'pg_toast'))::int AS total,
                array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text) AS schemas
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'm', 't', 'i')`
      );
      expect(enumerated.rows[0]?.total).toBeGreaterThan(500);
      // A new schema would hold relations no check walks: extend the diagnosis before this list.
      // `information_schema` is four static initdb tables and is deliberately not enumerated.
      expect(enumerated.rows[0]?.schemas).toEqual([
        'information_schema',
        'pg_catalog',
        'pg_toast',
        'public',
      ]);
      expect(diagnosis.checkedRelations + diagnosis.unchecked.length).toBe(
        enumerated.rows[0]?.total
      );
      expect(diagnosis.unchecked).toEqual([
        {
          accessMethod: 'hnsw',
          reason: 'empty-table',
          relation: 'idx_thread_message_index_embedding_hnsw',
          table: 'brainstrike_thread_message_index',
        },
      ]);
      expect(diagnosis.durationMs).toBeGreaterThan(0);
    });
  });

  it('counts every public table with its registry class and its real row count', async () => {
    await withDatabase(untouched, async (db) => {
      const diagnosis = await diagnose(db);
      const publicTables = await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      );
      expect(diagnosis.tables.map(({ table }) => table)).toEqual(
        publicTables.rows.map(({ tablename }) => tablename)
      );
      expect(diagnosis.tables.every(({ rows }) => rows !== null)).toBe(true);

      const byTable = new Map(diagnosis.tables.map((entry) => [entry.table, entry]));
      for (const { durability, table } of TABLE_DURABILITY_REGISTRY) {
        const counted = byTable.get(table);
        if (counted) {
          expect(counted.durability, table).toBe(durability);
        }
      }
      expect(byTable.get('file_chunks')).toMatchObject({ durability: 'derived', rows: CHUNKS });
      expect(byTable.get('file_records')).toMatchObject({ rows: 1 });
      expect(byTable.get(UNCLASSIFIED_TABLE)).toEqual({
        durability: 'unclassified',
        rows: PROBE_ROWS,
        table: UNCLASSIFIED_TABLE,
      });
    });
  });

  it('probes the bm25 and hnsw indexes through the index, with searches that return a row', async () => {
    await withDatabase(untouched, async (db) => {
      const { handle, statements } = recording(db);
      await diagnose(handle);

      const bm25Search = statements.find(({ sql }) => sql.includes('to_bm25query'));
      const hnswSearch = statements.find(
        ({ sql }) => sql.includes('<=>') && sql.includes('halfvec')
      );
      if (!(bm25Search && hnswSearch)) {
        throw new Error('the diagnosis issued no bm25 or hnsw probe');
      }
      for (const [statement, index] of [
        [bm25Search, BM25_INDEX],
        [hnswSearch, HNSW_INDEX],
      ] as const) {
        await db.exec('BEGIN; SET LOCAL enable_seqscan = off');
        try {
          const plan = await db.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN ${statement.sql}`,
            statement.params as unknown[] | undefined
          );
          expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n'), index).toContain(
            `Index Scan using ${index}`
          );
          const result = await db.query(statement.sql, statement.params as unknown[] | undefined);
          expect(result.rows, index).toHaveLength(1);
        } finally {
          await db.exec('ROLLBACK');
        }
      }
    });
  });

  it('leaves the data, the session settings and the transaction state as it found them', async () => {
    await withDatabase(untouched, async (db) => {
      const fingerprint = async (): Promise<string | undefined> =>
        (
          await db.query<{ fingerprint: string }>(
            `SELECT md5(string_agg(id || content, ',' ORDER BY id)) AS fingerprint FROM file_chunks`
          )
        ).rows[0]?.fingerprint;
      const before = await fingerprint();
      const { handle, statements } = recording(db);
      await diagnose(handle);

      expect(await fingerprint()).toBe(before);
      const sql = statements.map((entry) => entry.sql.trim());
      expect(sql.some((text) => text.startsWith('UPDATE'))).toBe(true);
      expect(sql.filter((text) => text === 'BEGIN')).toHaveLength(
        sql.filter((text) => text === 'ROLLBACK').length
      );
      expect(sql).not.toContain('COMMIT');
      for (const setting of [
        'enable_seqscan',
        'enable_indexscan',
        'enable_indexonlyscan',
        'enable_bitmapscan',
      ]) {
        const { rows } = await db.query<Record<string, string>>(`SHOW ${setting}`);
        expect(rows[0]?.[setting], setting).toBe('on');
      }
    });
  });
});

describe('damaged relations', () => {
  it('names a damaged btree index once, with its owning table class', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files[PKEY_INDEX], PAGE, PAGE),
      async (db) => {
        const diagnosis = await diagnose(db);
        expect(diagnosis.findings).toEqual([
          expect.objectContaining({
            accessMethod: 'btree',
            check: 'btree',
            durability: 'derived',
            relation: PKEY_INDEX,
            relationKind: 'index',
            sqlstate: 'XX001',
            table: 'file_chunks',
          }),
        ]);
        expect(diagnosis.findings[0]?.message).toContain('invalid page in block 1');
        expect(diagnosis.findings.map((finding) => classifyFindingSeverity(finding))).toEqual([
          'repairable',
        ]);
        // The probes would write through and read past every index of the table: they are not
        // blamed on the wrong relation, they are listed.
        expect(diagnosis.unchecked).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ reason: 'table-has-findings', relation: BM25_INDEX }),
            expect.objectContaining({ reason: 'table-has-findings', relation: HNSW_INDEX }),
          ])
        );
      }
    );
  });

  it('names a damaged gin index', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files[GIN_INDEX], PAGE, PAGE),
      async (db) => {
        const diagnosis = await diagnose(db);
        expect(diagnosis.findings).toEqual([
          expect.objectContaining({
            check: 'gin',
            durability: 'derived',
            relation: GIN_INDEX,
            relationKind: 'index',
            sqlstate: 'XX001',
            table: 'file_chunks',
          }),
        ]);
      }
    );
  });

  it('names a damaged heap and its unreadable row count, and a table the registry does not know as unclassified', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files[UNCLASSIFIED_TABLE], 24, 40),
      async (db) => {
        const diagnosis = await diagnose(db);
        expect(diagnosis.findings.map(({ check }) => check).sort()).toEqual(['heap', 'row-count']);
        for (const finding of diagnosis.findings) {
          expect(finding).toMatchObject({
            durability: 'unclassified',
            relation: UNCLASSIFIED_TABLE,
            relationKind: 'table',
            sqlstate: 'XX001',
            table: UNCLASSIFIED_TABLE,
          });
          expect(classifyFindingSeverity(finding)).toBe('blocking');
        }
        expect(diagnosis.tables.find(({ table }) => table === UNCLASSIFIED_TABLE)).toEqual({
          durability: 'unclassified',
          rows: null,
          table: UNCLASSIFIED_TABLE,
        });
      }
    );
  });

  it('reports what verify_heapam finds in a readable page, without a SQLSTATE', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files[UNCLASSIFIED_TABLE], 24, 40),
      async (db) => {
        // Reads the damaged page past its checksum so verify_heapam can describe the tuples.
        await db.exec('SET ignore_checksum_failure = on');
        const diagnosis = await diagnose(db);
        const heap = diagnosis.findings.find(({ check }) => check === 'heap');
        expect(heap).toMatchObject({
          check: 'heap',
          relation: UNCLASSIFIED_TABLE,
          sqlstate: null,
        });
        expect(heap?.message).toMatch(/^block 0, offset \d+: line pointer/u);
      }
    );
  });

  it('names a bm25 index whose probe cannot read it', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files[BM25_INDEX], 0, PAGE),
      async (db) => {
        const diagnosis = await diagnose(db);
        expect(diagnosis.findings).toEqual([
          expect.objectContaining({
            accessMethod: 'bm25',
            check: 'bm25-probe',
            durability: 'derived',
            relation: BM25_INDEX,
            relationKind: 'index',
            sqlstate: 'XX001',
            table: 'file_chunks',
          }),
        ]);
        // The probe searched with text taken from the table; none of it may reach a finding.
        expect(JSON.stringify(diagnosis)).not.toContain('pipeline scheduler');
        // The transaction the probe opened was rolled back even though it failed.
        const { rows } = await db.query<{ ok: number }>('SELECT 1 AS ok');
        expect(rows).toEqual([{ ok: 1 }]);
      }
    );
  });

  it('names an hnsw index whose probe cannot read it', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files[HNSW_INDEX], 0, PAGE),
      async (db) => {
        const diagnosis = await diagnose(db);
        expect(diagnosis.findings).toEqual([
          expect.objectContaining({
            accessMethod: 'hnsw',
            check: 'hnsw-probe',
            durability: 'derived',
            relation: HNSW_INDEX,
            relationKind: 'index',
            sqlstate: 'XX001',
            table: 'file_chunks',
          }),
        ]);
      }
    );
  });

  it('cuts findings to maxFindings, keeping blocking ones first and reporting the cut', async () => {
    await withDatabase(
      async (dir, files) => {
        await overwriteBytes(dir, files[UNCLASSIFIED_TABLE], 24, 40);
        await overwriteBytes(dir, files[PKEY_INDEX], PAGE, PAGE);
        await overwriteBytes(dir, files[base.secondBtreeIndex], PAGE, PAGE);
      },
      async (db) => {
        const all = await diagnose(db);
        expect(all.findingsTruncated).toBe(false);
        expect(all.findings.length).toBeGreaterThanOrEqual(4);

        const cut = await diagnose(db, { maxFindings: 1 });
        expect(cut.findingsTruncated).toBe(true);
        expect(cut.findings).toHaveLength(1);
        expect(cut.findings.map((finding) => classifyFindingSeverity(finding))).toEqual([
          'blocking',
        ]);
        // Nothing but the findings list is cut.
        expect(cut.checkedRelations).toBe(all.checkedRelations);
        expect(cut.tables).toEqual(all.tables);
      }
    );
  });
});

/** A handle whose `bt_index_check` of `relation` fails with `error`; everything else runs for real. */
function failingBtreeCheck(db: PGlite, relation: string, error: Error): CrashSensitiveIndexDb {
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

describe('the diagnosis contract', () => {
  it('attributes an error to the relation being checked and bounds its message', async () => {
    await withDatabase(untouched, async (db) => {
      const failing = failingBtreeCheck(
        db,
        PKEY_INDEX,
        Object.assign(new Error('x'.repeat(1000)), { code: 'XX002' })
      );
      const diagnosis = await diagnose(failing);
      expect(diagnosis.findings).toHaveLength(1);
      const [finding] = diagnosis.findings;
      expect(finding).toMatchObject({ check: 'btree', relation: PKEY_INDEX, sqlstate: 'XX002' });
      expect(finding?.message).toHaveLength(240);
    });
  });

  it('names a damaged system-catalog index as catalog, and blocking', async () => {
    await withDatabase(untouched, async (db) => {
      const failing = failingBtreeCheck(
        db,
        'pg_class_oid_index',
        Object.assign(new Error('catalog index damaged'), { code: 'XX002' })
      );
      const diagnosis = await diagnose(failing);
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({
          accessMethod: 'btree',
          check: 'btree',
          durability: 'catalog',
          relation: 'pg_class_oid_index',
          relationKind: 'index',
          table: 'pg_class',
        }),
      ]);
      expect(diagnosis.findings.map((finding) => classifyFindingSeverity(finding))).toEqual([
        'blocking',
      ]);
    });
  });

  it('stops on a poisoned instance instead of blaming every remaining relation', async () => {
    await withDatabase(untouched, async (db) => {
      let heapChecks = 0;
      const trapping: CrashSensitiveIndexDb = {
        exec: (sql) => db.exec(sql),
        query: (sql, params) => {
          if (sql.includes('verify_heapam')) {
            heapChecks += 1;
            if (heapChecks === 3) {
              throw Object.assign(new Error('WebAssembly trap'), { name: 'PGliteFatalTrapError' });
            }
          }
          return db.query(sql, params);
        },
      };
      await expect(diagnose(trapping)).rejects.toMatchObject({ name: 'PGliteFatalTrapError' });
      expect(heapChecks).toBe(3);
    });
  });

  it('refuses to run without amcheck, rather than reporting every relation as failed', async () => {
    const db = await createVerificationPglite();
    try {
      await expect(diagnose(db)).rejects.toThrow(/amcheck/u);
    } finally {
      await db.close();
    }
  });

  it('rejects a maxFindings that is not a positive integer', async () => {
    await withDatabase(untouched, async (db) => {
      await expect(diagnose(db, { maxFindings: 0 })).rejects.toThrow(RangeError);
    });
  });
});
