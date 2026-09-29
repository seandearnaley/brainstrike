/**
 * BST-1877 L1: relation-by-relation integrity diagnosis on a real NodeFS PGlite data directory:
 * the healthy database, damaged relations, sequences and the diagnosis contract. The probe,
 * cleanup and unchecked-relation cases are in `database-integrity-diagnosis-probes.integration.test.ts`;
 * both build their database with `helpers/diagnosis-fixture.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CrashSensitiveIndexDb } from '../src/crash-sensitive-indexes.js';
import { classifyFindingSeverity } from '../src/database-integrity-finding.js';
import { createVerificationPglite } from '../src/pglite-verification-factory.js';
import { TABLE_DURABILITY_REGISTRY } from '../src/table-durability-registry.js';
import {
  BM25_INDEX,
  CHUNKS,
  diagnose,
  failingBtreeCheck,
  GIN_INDEX,
  getBase,
  HNSW_INDEX,
  HNSW_PROBE,
  overwriteBytes,
  PAGE,
  PKEY_INDEX,
  PROBE_ROWS,
  planWalksIndex,
  recording,
  registerDiagnosisFixture,
  SEQUENCE,
  SEQUENCE_OWNER,
  TOASTED_CHUNKS,
  UNCLASSIFIED_TABLE,
  untouched,
  withDatabase,
} from './helpers/diagnosis-fixture.js';

registerDiagnosisFixture();

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
          WHERE c.relkind IN ('r', 'm', 't', 'i', 'S')`
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
          reason: 'no-indexed-rows',
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
      expect(byTable.get('file_chunks')).toMatchObject({
        durability: 'derived',
        rows: CHUNKS + TOASTED_CHUNKS,
      });
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
      const hnswSearch = statements.find(({ sql }) => HNSW_PROBE(sql));
      if (!(bm25Search && hnswSearch)) {
        throw new Error('the diagnosis issued no bm25 or hnsw probe');
      }
      for (const [statement, index] of [
        [bm25Search, BM25_INDEX],
        [hnswSearch, HNSW_INDEX],
      ] as const) {
        expect(await planWalksIndex(db, statement, index), index).toBe(true);
        await db.exec('BEGIN; SET LOCAL enable_seqscan = off');
        try {
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
        await overwriteBytes(dir, files[getBase().secondBtreeIndex], PAGE, PAGE);
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

describe('sequences', () => {
  it('names a damaged sequence as a heap finding on the table that owns it', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files[SEQUENCE], 0, PAGE),
      async (db) => {
        const diagnosis = await diagnose(db);
        expect(diagnosis.findings).toEqual([
          expect.objectContaining({
            check: 'heap',
            durability: 'precious',
            relation: SEQUENCE,
            relationKind: 'table',
            sqlstate: 'XX001',
            table: SEQUENCE_OWNER,
          }),
        ]);
        expect(diagnosis.findings.map((finding) => classifyFindingSeverity(finding))).toEqual([
          'blocking',
        ]);
      }
    );
  });
});

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
