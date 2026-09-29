/**
 * BST-1877 L1: what the diagnosis does when a check reaches past its own relation (TOAST, heap
 * blame), when a probe's reads fail, when an index returns nothing, and for the shapes it cannot
 * check. Built with `helpers/diagnosis-fixture.ts`.
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { CrashSensitiveIndexDb } from '../src/crash-sensitive-indexes.js';
import { diagnoseDatabaseIntegrity } from '../src/database-integrity-diagnosis.js';
import { classifyFindingSeverity } from '../src/database-integrity-finding.js';
import {
  answering,
  BM25_INDEX,
  diagnose,
  failingBtreeCheck,
  failingStatements,
  getBase,
  HNSW_INDEX,
  HNSW_PROBE,
  overwriteBytes,
  PAGE,
  PKEY_INDEX,
  readError,
  recording,
  registerDiagnosisFixture,
  statementWalksIndex,
  TOAST_KEY,
  untouched,
  withDatabase,
} from './helpers/diagnosis-fixture.js';

registerDiagnosisFixture();

describe('damage that reaches past the relation being checked', () => {
  it('names a damaged TOAST page as a heap finding on the table that owns it', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files[TOAST_KEY], 0, PAGE),
      async (db) => {
        const diagnosis = await diagnose(db);
        // verify_heapam without check_toast passes file_chunks; the diagnosis asks for the toast check.
        expect(diagnosis.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              check: 'heap',
              durability: 'derived',
              relation: 'file_chunks',
              sqlstate: 'XX001',
              table: 'file_chunks',
            }),
          ])
        );
      }
    );
  });

  it('does not blame every btree index of a table for damage in its heap', async () => {
    await withDatabase(
      (dir, files) => overwriteBytes(dir, files.file_chunks, 0, PAGE),
      async (db) => {
        const diagnosis = await diagnose(db);
        // The heap is the damaged relation: bt_index_check(heapallindexed) would read it once per index.
        expect(diagnosis.findings.map(({ check }) => check).sort()).toEqual(['heap', 'row-count']);
        const skipped = diagnosis.unchecked.filter(
          ({ accessMethod, reason, table }) =>
            accessMethod === 'btree' && reason === 'table-has-findings' && table === 'file_chunks'
        );
        expect(skipped.map(({ relation }) => relation)).toContain(PKEY_INDEX);
        expect(diagnosis.checkedRelations + diagnosis.unchecked.length).toBeGreaterThan(500);
      }
    );
  });

  it('still names a damaged index on a table whose heap is fine', async () => {
    await withDatabase(
      async (dir, files) => {
        await overwriteBytes(dir, files[PKEY_INDEX], PAGE, PAGE);
        await overwriteBytes(dir, files[getBase().secondBtreeIndex], PAGE, PAGE);
      },
      async (db) => {
        const diagnosis = await diagnose(db);
        // One index finding does not gate the heap reads of the next index on the same table.
        expect(diagnosis.findings.map(({ relation }) => relation).sort()).toEqual(
          [PKEY_INDEX, getBase().secondBtreeIndex].sort()
        );
      }
    );
  });
});

describe('a catalog read that fails stops the run, and is never a finding on a user relation', () => {
  const stopped = (stage: string) =>
    expect.objectContaining({ name: 'IntegrityDiagnosisStoppedError', stage });

  it.each([
    ['an index definition', 'pg_get_indexdef(i.indexrelid, 1, true)'],
    ['the relation list', 'FROM pg_class c'],
    ['the amcheck lookup', 'FROM pg_extension'],
  ])('stops, with the catalog stage, when reading %s fails', async (_label, fragment) => {
    await withDatabase(untouched, async (db) => {
      await expect(
        diagnose(failingStatements(db, readError(), (sql) => sql.includes(fragment)))
      ).rejects.toEqual(stopped('catalog'));
    });
  });

  it.each([
    ['BEGIN', (sql: string) => sql === 'BEGIN'],
    ['SET LOCAL', (sql: string) => sql.startsWith('SET LOCAL')],
    ['the count settings', (sql: string) => sql.startsWith('SET enable_indexscan')],
  ])(
    'stops, with the session stage, when %s fails, never as a probe finding',
    async (_label, fails) => {
      await withDatabase(untouched, async (db) => {
        const handle = failingStatements(
          db,
          readError(),
          () => false,
          (sql) => (fails(sql) ? readError() : undefined)
        );
        await expect(diagnose(handle)).rejects.toEqual(stopped('session'));
      });
    }
  );

  it('lets a fatal trap through a catalog read unwrapped', async () => {
    await withDatabase(untouched, async (db) => {
      const trap = Object.assign(new Error('WebAssembly trap'), { name: 'PGliteFatalTrapError' });
      await expect(
        diagnose(failingStatements(db, trap, (sql) => sql.includes('FROM pg_class c')))
      ).rejects.toBe(trap);
    });
  });

  it('carries no raw probe error out of a failed rollback', async () => {
    await withDatabase(untouched, async (db) => {
      const echo = Object.assign(new Error('refused topic0 md5'), { code: 'XX001' });
      const handle = failingStatements(db, echo, HNSW_PROBE, (sql) =>
        sql === 'ROLLBACK' ? new Error('rollback failed near topic0') : undefined
      );
      const error = await diagnose(handle).catch((thrown: unknown) => thrown);
      expect(error).toEqual(stopped('cleanup'));
      expect((error as Error).cause).toBeUndefined();
      expect(String((error as Error).message)).not.toContain('topic');
    });
  });
});

describe('a probe must walk its own index', () => {
  it('lists an hnsw index the planner does not choose as unchecked, not as clean', async () => {
    await withDatabase(untouched, async (db) => {
      // Two identical indexes: the planner uses one of them for the probe's search.
      await db.exec(`
        CREATE TABLE zz_dup (emb vector(3));
        INSERT INTO zz_dup SELECT ('[' || g || ',1,2]')::vector FROM generate_series(1, 30) g;
        CREATE INDEX zz_dup_a ON zz_dup USING hnsw (emb vector_cosine_ops);
        CREATE INDEX zz_dup_b ON zz_dup USING hnsw (emb vector_cosine_ops);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      const notDriven = diagnosis.unchecked.filter(
        ({ reason }) => reason === 'probe-not-index-driven'
      );
      expect(notDriven).toHaveLength(1);
      expect(['zz_dup_a', 'zz_dup_b']).toContain(notDriven[0]?.relation);
    });
  });

  it('lists a bm25 index as unchecked when the plan reads another index and sorts', async () => {
    await withDatabase(untouched, async (db) => {
      const plan = [
        {
          Plan: {
            'Node Type': 'Sort',
            Plans: [
              {
                'Index Name': PKEY_INDEX,
                'Node Type': 'Index Scan',
                'Order By': '(id)',
                'Parent Relationship': 'Outer',
              },
            ],
          },
        },
      ];
      const handle = answering(db, (sql) =>
        sql.startsWith('EXPLAIN (FORMAT JSON)') && sql.includes('to_bm25query')
          ? [{ 'QUERY PLAN': plan }]
          : undefined
      );
      const diagnosis = await diagnose(handle);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({ reason: 'probe-not-index-driven', relation: BM25_INDEX })
      );
    });
  });

  it('probes an index whose name needs quoting: mixed case and a space', async () => {
    await withDatabase(untouched, async (db) => {
      // No test can make the qualified form matter more: every probe function needs public on the
      // search_path anyway. It is adopted as hardening, and the resolution test below pins both forms.
      await db.exec(`
        CREATE TABLE zz_named (body text);
        INSERT INTO zz_named SELECT 'quaternion interpolation ' || g FROM generate_series(1, 5) g;
        CREATE INDEX "Zz Mixed Bm25" ON zz_named USING bm25 (body) WITH (text_config=english);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked.map(({ relation }) => relation)).not.toContain('Zz Mixed Bm25');
    });
  });

  it('lists a bm25 index whose name contains a dot as unchecked: no form of the name resolves', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_dotted (body text);
        INSERT INTO zz_dotted SELECT 'quaternion interpolation ' || g FROM generate_series(1, 5) g;
        CREATE INDEX "Zz.Dotted" ON zz_dotted USING bm25 (body) WITH (text_config=english);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({ reason: 'unsupported-index-definition', relation: 'Zz.Dotted' })
      );
    });
  });

  it('pins how pg_textsearch resolves the index name: an unqualified name is exact, a qualified one is SQL syntax, a dotted one has no form', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_resolve (body text);
        INSERT INTO zz_resolve VALUES ('quaternion interpolation');
        CREATE INDEX "Zz Pin" ON zz_resolve USING bm25 (body) WITH (text_config=english);
        CREATE INDEX "Zz.Pin" ON zz_resolve USING bm25 (body) WITH (text_config=english);`);
      const search = async (name: string) => {
        await db.exec('BEGIN; SET LOCAL enable_seqscan = off');
        try {
          return await db.query(
            `SELECT 1 FROM zz_resolve ORDER BY body <@> to_bm25query('quaternion', '${name}') LIMIT 1`
          );
        } finally {
          await db.exec('ROLLBACK');
        }
      };
      expect((await search('Zz Pin')).rows).toHaveLength(1);
      expect((await search('"public"."Zz Pin"')).rows).toHaveLength(1);
      await expect(search('"Zz Pin"')).rejects.toMatchObject({ code: '42704' });
      await expect(search('Zz.Pin')).rejects.toMatchObject({ code: '42704' });
      await expect(search('"public"."Zz.Pin"')).rejects.toThrow(/not found/u);
    });
  });
});

describe('the bm25 write probe blames no other index', () => {
  it.each([
    [
      'an index with no check for its access method',
      'CREATE INDEX zz_w_brin ON zz_w USING brin (n);',
    ],
    [
      'an hnsw index with no row it covers',
      'CREATE INDEX zz_w_hnsw ON zz_w USING hnsw (emb vector_cosine_ops);',
    ],
    [
      'an index marked invalid but still written',
      `CREATE INDEX zz_w_btree ON zz_w (n);
       UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'zz_w_btree'::regclass;`,
    ],
  ])('skips the write, listing the bm25 index as unchecked, for %s', async (_label, other) => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_w (n int, body text, emb vector(3));
        INSERT INTO zz_w SELECT g, 'quaternion interpolation ' || g, NULL FROM generate_series(1, 5) g;
        CREATE INDEX zz_w_bm25 ON zz_w USING bm25 (body) WITH (text_config=english);
        ${other}`);
      const { handle, statements } = recording(db);
      const diagnosis = await diagnose(handle);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({ reason: 'table-has-unverified-indexes', relation: 'zz_w_bm25' })
      );
      expect(diagnosis.findings.filter(({ check }) => check === 'bm25-probe')).toEqual([]);
      expect(statements.some(({ sql }) => sql.startsWith('UPDATE "public"."zz_w"'))).toBe(false);
    });
  });
});

describe('the bm25 write probes do not depend on the order of the checks', () => {
  it('write-probes two bm25 indexes on one healthy table: neither blocks the other', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_two (a text, b text);
        INSERT INTO zz_two SELECT 'quaternion ' || g, 'interpolation ' || g FROM generate_series(1, 5) g;
        CREATE INDEX zz_two_a ON zz_two USING bm25 (a) WITH (text_config=english);
        CREATE INDEX zz_two_b ON zz_two USING bm25 (b) WITH (text_config=english);`);
      const { handle, statements } = recording(db);
      const diagnosis = await diagnose(handle);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked.filter(({ table }) => table === 'zz_two')).toEqual([]);
      expect(
        statements.filter(({ sql }) => sql.startsWith('UPDATE "public"."zz_two"'))
      ).toHaveLength(2);
    });
  });

  it('lists two identical bm25 indexes as unchecked: the planner reads only one, and pg_textsearch refuses the other', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_same (body text);
        INSERT INTO zz_same SELECT 'quaternion interpolation ' || g FROM generate_series(1, 5) g;
        CREATE INDEX zz_same_a ON zz_same USING bm25 (body) WITH (text_config=english);
        CREATE INDEX zz_same_b ON zz_same USING bm25 (body) WITH (text_config=english);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(
        diagnosis.unchecked
          .filter(({ table }) => table === 'zz_same')
          .map(({ reason }) => reason)
          .sort()
      ).toEqual(['probe-not-index-driven', 'table-has-unverified-indexes']);
    });
  });

  it('does not skip the write for a btree that sorts after the bm25 index', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_order (n int, body text);
        INSERT INTO zz_order SELECT g, 'quaternion interpolation ' || g FROM generate_series(1, 5) g;
        CREATE INDEX zz_order_a_bm25 ON zz_order USING bm25 (body) WITH (text_config=english);
        CREATE INDEX zz_order_z_btree ON zz_order (n);`);
      const { handle, statements } = recording(db);
      const diagnosis = await diagnose(handle);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked.filter(({ table }) => table === 'zz_order')).toEqual([]);
      expect(statements.some(({ sql }) => sql.startsWith('UPDATE "public"."zz_order"'))).toBe(true);
    });
  });

  it('still lets a bm25 sibling that could not be read-probed block the write', async () => {
    await withDatabase(untouched, async (db) => {
      // The second index has no row it covers (a partial predicate nothing satisfies).
      await db.exec(`
        CREATE TABLE zz_sib (n int, body text);
        INSERT INTO zz_sib SELECT g, 'quaternion interpolation ' || g FROM generate_series(1, 5) g;
        CREATE INDEX zz_sib_a ON zz_sib USING bm25 (body) WITH (text_config=english);
        CREATE INDEX zz_sib_b ON zz_sib USING bm25 (body) WITH (text_config=english) WHERE n > 100;`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({ reason: 'table-has-unverified-indexes', relation: 'zz_sib_a' })
      );
    });
  });

  it('skips a write whose search passed when a later bm25 search on the table is a finding', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_late (a text, b text);
        INSERT INTO zz_late SELECT 'quaternion ' || g, 'interpolation ' || g FROM generate_series(1, 5) g;
        CREATE INDEX zz_late_a ON zz_late USING bm25 (a) WITH (text_config=english);
        CREATE INDEX zz_late_b ON zz_late USING bm25 (b) WITH (text_config=english);`);
      const failing = failingStatements(
        db,
        Object.assign(new Error('search failed'), { code: 'P0001' }),
        (sql) => sql.startsWith('SELECT 1 FROM "public"."zz_late"') && sql.includes('zz_late_b')
      );
      const diagnosis = await diagnose(failing);
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({ check: 'bm25-probe', relation: 'zz_late_b', sqlstate: 'P0001' }),
      ]);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({ reason: 'table-has-findings', relation: 'zz_late_a' })
      );
    });
  });
});

describe('only a constraint the table enforces makes a probe write "rejected"', () => {
  const failingWrite = (db: PGlite, code: string) =>
    failingStatements(db, Object.assign(new Error('write failed'), { code }), (sql) =>
      sql.startsWith('UPDATE "public"."file_chunks"')
    );

  it.each(['23514', '23502', '22001', '23505'])(
    'lists the index as unchecked when the write fails with %s',
    async (code) => {
      await withDatabase(untouched, async (db) => {
        const diagnosis = await diagnose(failingWrite(db, code));
        expect(diagnosis.findings).toEqual([]);
        expect(diagnosis.unchecked).toContainEqual(
          expect.objectContaining({ reason: 'probe-write-rejected', relation: BM25_INDEX })
        );
      });
    }
  );

  // Corrupt bytes can raise these from the concatenation or the tokenizer: they are damage.
  it.each(['22021', '22P05', '22000', '23503'])(
    'reports a write that fails with %s as a finding',
    async (code) => {
      await withDatabase(untouched, async (db) => {
        const diagnosis = await diagnose(failingWrite(db, code));
        expect(diagnosis.findings).toEqual([
          expect.objectContaining({ check: 'bm25-probe', relation: BM25_INDEX, sqlstate: code }),
        ]);
      });
    }
  );
});

describe('a schema name that contains a dot', () => {
  it('lists the bm25 index as unchecked: the qualified name would not resolve', async () => {
    await withDatabase(untouched, async (db) => {
      // No such schema is enumerated, so the row is rewritten the way the catalog would list it.
      const dotted: CrashSensitiveIndexDb['query'] = async (sql, params) => {
        const result = await db.query(sql, params);
        if (!sql.includes('FROM pg_class c')) {
          return result as never;
        }
        const rows = (result.rows as { relation: string }[]).map((row) =>
          row.relation === BM25_INDEX ? { ...row, schema: 'zz.dotted' } : row
        );
        return { ...result, rows } as never;
      };
      const diagnosis = await diagnose({ exec: (sql) => db.exec(sql), query: dotted });
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({ reason: 'unsupported-index-definition', relation: BM25_INDEX })
      );
    });
  });
});

describe('a probe write the table rejects is not damage', () => {
  it('still reports a write that fails with no SQLSTATE, as a finding with no state', async () => {
    await withDatabase(untouched, async (db) => {
      const handle = failingStatements(db, new Error('no code'), (sql) =>
        sql.startsWith('UPDATE "public"."file_chunks"')
      );
      const diagnosis = await diagnose(handle);
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({ check: 'bm25-probe', relation: BM25_INDEX, sqlstate: null }),
      ]);
    });
  });

  it.each([
    ['a CHECK constraint', `CHECK (body NOT LIKE '% ')`],
    ['a domain constraint', ''],
    ['a constraint raising a class 22 error', 'CHECK (zz_short(body))'],
  ])('lists the index as unchecked when %s rejects the write', async (label, check) => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE FUNCTION zz_short(v text) RETURNS boolean LANGUAGE plpgsql AS
          $$ BEGIN IF v LIKE '% ' THEN RAISE EXCEPTION 'too long' USING ERRCODE = '22001'; END IF; RETURN true; END $$;
        CREATE DOMAIN zz_dom AS text CHECK (VALUE NOT LIKE '% ');
        CREATE TABLE zz_rej (body ${label === 'a domain constraint' ? 'zz_dom' : 'text'} ${check});
        INSERT INTO zz_rej VALUES ('quaternion interpolation');
        CREATE INDEX zz_rej_bm25 ON zz_rej USING bm25 (body) WITH (text_config=english);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({ reason: 'probe-write-rejected', relation: 'zz_rej_bm25' })
      );
    });
  });

  it('checks a varchar(n) column at its limit: the appended space is truncated, not rejected', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_vc (body varchar(12));
        INSERT INTO zz_vc VALUES ('quaternion i');
        CREATE INDEX zz_vc_bm25 ON zz_vc USING bm25 (body) WITH (text_config=english);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked.map(({ relation }) => relation)).not.toContain('zz_vc_bm25');
    });
  });
});

describe('an unpopulated materialized view with probed indexes', () => {
  it('lists its hnsw and bm25 indexes as unchecked instead of reporting a false finding', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE MATERIALIZED VIEW zz_mv AS SELECT 'text'::text AS body, '[1,2,3]'::vector(3) AS emb WITH NO DATA;
        CREATE INDEX zz_mv_bm25 ON zz_mv USING bm25 (body) WITH (text_config=english);
        CREATE INDEX zz_mv_hnsw ON zz_mv USING hnsw (emb vector_cosine_ops);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      for (const relation of ['zz_mv_bm25', 'zz_mv_hnsw']) {
        expect(diagnosis.unchecked, relation).toContainEqual(
          expect.objectContaining({ reason: 'unpopulated-materialized-view', relation })
        );
      }
    });
  });
});

describe('what a finding says about a table outside public', () => {
  it('never classifies it through the public registry by its bare name', async () => {
    await withDatabase(untouched, async (db) => {
      // A registered table's name, in another schema, with a TOAST relation listed from pg_toast.
      await db.exec(`
        CREATE SCHEMA zz_other;
        CREATE TABLE zz_other.file_chunks (body text);
        INSERT INTO zz_other.file_chunks SELECT string_agg(md5(random()::text || k::text), '')
          FROM generate_series(1, 400) k;`);
      const { rows } = await db.query<{ oid: string }>(
        `SELECT reltoastrelid::text AS oid FROM pg_class WHERE oid = 'zz_other.file_chunks'::regclass`
      );
      const toastOid = rows[0]?.oid;
      const diagnosis = await diagnose(
        answering(db, (sql, params) =>
          sql.includes('verify_heapam') && String(params?.[0]) === toastOid
            ? [{ blkno: '0', msg: 'damaged', offnum: 1 }]
            : undefined
        )
      );
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({
          check: 'heap',
          durability: 'unclassified',
          table: 'file_chunks',
        }),
      ]);
    });
  });
});

describe('a probe whose setup reads fail', () => {
  it.each([
    ['its bm25 sample', 'left(', ['bm25-probe']],
    [
      'its hnsw population check',
      'SELECT EXISTS (SELECT 1 FROM "public"."file_chunks"',
      ['hnsw-probe'],
    ],
  ])(
    'turns a failing read of %s into a finding, and finishes the diagnosis',
    async (_label, fragment, checks) => {
      await withDatabase(untouched, async (db) => {
        const diagnosis = await diagnose(
          failingStatements(db, readError(), (sql) => sql.includes(fragment))
        );
        expect(diagnosis.findings.map(({ check }) => check).sort()).toEqual([...checks].sort());
        expect(diagnosis.findings.every(({ sqlstate }) => sqlstate === 'XX000')).toBe(true);
        expect(diagnosis.tables.every(({ rows }) => rows !== null)).toBe(true);
      });
    }
  );
});

describe('cleanup after a failure', () => {
  const trap = () => Object.assign(new Error('WebAssembly trap'), { name: 'PGliteFatalTrapError' });

  it('does not roll back a poisoned instance, and rethrows the original trap', async () => {
    await withDatabase(untouched, async (db) => {
      const cleanups: string[] = [];
      const handle = failingStatements(db, trap(), HNSW_PROBE, (sql) => {
        if (sql === 'ROLLBACK') {
          cleanups.push(sql);
          return new Error('cleanup ran on a dead instance');
        }
        return;
      });
      await expect(diagnose(handle)).rejects.toMatchObject({ name: 'PGliteFatalTrapError' });
      expect(cleanups).toEqual([]);
    });
  });

  it('stops, rather than reporting a finding, when a probe transaction cannot be rolled back', async () => {
    await withDatabase(untouched, async (db) => {
      const handle = failingStatements(
        db,
        Object.assign(new Error('probe failed'), { code: 'XX001' }),
        HNSW_PROBE,
        (sql) => (sql === 'ROLLBACK' ? new Error('rollback failed') : undefined)
      );
      await expect(diagnose(handle)).rejects.toThrow(/could not be rolled back/u);
    });
  });

  it('does not reset session settings on a poisoned instance, and rethrows the original trap', async () => {
    await withDatabase(untouched, async (db) => {
      const resets: string[] = [];
      const handle = failingStatements(
        db,
        trap(),
        (sql) => sql.includes('count(*)') && sql.includes('"file_records"'),
        (sql) => {
          if (sql.startsWith('RESET')) {
            resets.push(sql);
            return new Error('reset ran on a dead instance');
          }
          return;
        }
      );
      await expect(diagnose(handle)).rejects.toMatchObject({ name: 'PGliteFatalTrapError' });
      expect(resets).toEqual([]);
    });
  });
});

describe('an index that returns nothing for rows it should cover', () => {
  /** A table whose index missed every insert: `indisready` false hides it from index maintenance. */
  async function tableWithLostIndex(db: PGlite, indexSql: string, index: string): Promise<void> {
    await db.exec(`CREATE TABLE zz_lost (id int, body text, emb vector(3)); ${indexSql}`);
    await db.exec(`UPDATE pg_index SET indisready = false WHERE indexrelid = '${index}'::regclass`);
    await db.exec(`
      INSERT INTO zz_lost SELECT g, 'quaternion interpolation pipeline ' || g, ('[' || g || ',1,2]')::vector
        FROM generate_series(1, 20) g`);
    await db.exec(`UPDATE pg_index SET indisready = true WHERE indexrelid = '${index}'::regclass`);
  }

  it('names an hnsw index that lost its entries, instead of counting the empty probe as checked', async () => {
    await withDatabase(untouched, async (db) => {
      await tableWithLostIndex(
        db,
        'CREATE INDEX zz_lost_hnsw ON zz_lost USING hnsw (emb vector_cosine_ops);',
        'zz_lost_hnsw'
      );
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({
          check: 'hnsw-probe',
          durability: 'unclassified',
          relation: 'zz_lost_hnsw',
          relationKind: 'index',
          sqlstate: null,
          table: 'zz_lost',
        }),
      ]);
      expect(diagnosis.findings.map((finding) => classifyFindingSeverity(finding))).toEqual([
        'repairable',
      ]);
    });
  });

  it('names a bm25 index that lost its entries', async () => {
    await withDatabase(untouched, async (db) => {
      await tableWithLostIndex(
        db,
        'CREATE INDEX zz_lost_bm25 ON zz_lost USING bm25 (body) WITH (text_config=english);',
        'zz_lost_bm25'
      );
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({
          check: 'bm25-probe',
          relation: 'zz_lost_bm25',
          sqlstate: null,
          table: 'zz_lost',
        }),
      ]);
    });
  });

  it('does not blame an index for a sample that has no indexable term', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_stopwords (body text);
        INSERT INTO zz_stopwords VALUES ('the of and'), ('the of and');
        CREATE INDEX zz_stopwords_bm25 ON zz_stopwords USING bm25 (body) WITH (text_config=english);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'no-indexed-rows', relation: 'zz_stopwords_bm25' }),
        ])
      );
    });
  });
});

describe('bm25 probes on a partial index, and on a table with triggers', () => {
  const PARTIAL_TABLE = `
    CREATE TABLE zz_part (id int, keep boolean, body text);
    INSERT INTO zz_part SELECT g, g > 10, 'quaternion interpolation pipeline ' || g FROM generate_series(1, 20) g;
    CREATE INDEX zz_part_bm25 ON zz_part USING bm25 (body) WITH (text_config=english) WHERE keep;`;

  it('applies the index predicate to the sample, the search and the write, and proves the search walks the index', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(PARTIAL_TABLE);
      const { handle, statements } = recording(db);
      const diagnosis = await diagnose(handle);
      // The first rows lie outside the predicate: a sample taken from them is not in the index.
      expect(diagnosis.findings).toEqual([]);
      const search = statements.find(
        ({ sql }) =>
          sql.includes('to_bm25query') && sql.includes('zz_part_bm25') && !sql.startsWith('EXPLAIN')
      );
      if (!search) {
        throw new Error('the diagnosis issued no bm25 probe for the partial index');
      }
      expect(await statementWalksIndex(db, search, 'zz_part_bm25')).toBe(true);
    });
  });

  it('does not run user triggers in the probe write, which rolls back', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE FUNCTION zz_refuse_update() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'updates refused'; END $$;
        CREATE TRIGGER zz_refuse BEFORE UPDATE ON file_chunks
          FOR EACH ROW EXECUTE FUNCTION zz_refuse_update();`);
      expect((await diagnose(db)).findings).toEqual([]);
    });
  });
});

describe('hnsw samples', () => {
  it('does not blame an index for a NULL or zero vector that the index never held', async () => {
    await withDatabase(untouched, async (db) => {
      // Heap order puts the NULL and the zero vector first; pgvector indexes neither.
      await db.exec(`
        CREATE TABLE zz_vectors (emb vector(3));
        INSERT INTO zz_vectors VALUES (NULL), ('[0,0,0]'), ('[1,2,3]'), ('[3,2,1]');
        CREATE INDEX zz_vectors_hnsw ON zz_vectors USING hnsw (emb vector_cosine_ops);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked.map(({ relation }) => relation)).not.toContain('zz_vectors_hnsw');
    });
  });

  it('lists an index over nothing but a zero vector as unchecked, not as damaged', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_zero (emb vector(3));
        INSERT INTO zz_zero VALUES ('[0,0,0]');
        CREATE INDEX zz_zero_hnsw ON zz_zero USING hnsw (emb vector_cosine_ops);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({ reason: 'no-indexed-rows', relation: 'zz_zero_hnsw' })
      );
    });
  });
});

describe('invalid indexes and unpopulated views', () => {
  it.each([
    ['invalid', 'indisvalid'],
    ['not ready', 'indisready'],
  ])(
    'reports an index left %s as its own finding, without an error from checking it',
    async (_label, flag) => {
      await withDatabase(untouched, async (db) => {
        await db.exec(
          `UPDATE pg_index SET ${flag} = false WHERE indexrelid = '${PKEY_INDEX}'::regclass`
        );
        const diagnosis = await diagnose(db);
        expect(diagnosis.findings).toEqual([
          expect.objectContaining({
            accessMethod: 'btree',
            check: 'index-invalid',
            durability: 'derived',
            relation: PKEY_INDEX,
            relationKind: 'index',
            sqlstate: null,
            table: 'file_chunks',
          }),
        ]);
        expect(diagnosis.findings.map((finding) => classifyFindingSeverity(finding))).toEqual([
          'repairable',
        ]);
        expect(diagnosis.unchecked.map(({ relation }) => relation)).not.toContain(PKEY_INDEX);
      });
    }
  );

  it('lists an unpopulated materialized view as unchecked instead of failing its row count', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec('CREATE MATERIALIZED VIEW zz_view AS SELECT 1 AS n WITH NO DATA');
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toContainEqual(
        expect.objectContaining({
          reason: 'unpopulated-materialized-view',
          relation: 'zz_view',
          table: 'zz_view',
        })
      );
      expect(diagnosis.tables.find(({ table }) => table === 'zz_view')).toMatchObject({
        rows: null,
      });
    });
  });
});

describe('what a probe finding may say', () => {
  it('keeps the SQLSTATE and a fixed description, never text the error echoes from a row', async () => {
    await withDatabase(untouched, async (db) => {
      // ENABLE ALWAYS fires even in the replica role the probe write runs under.
      await db.exec(`
        CREATE FUNCTION zz_echo_content() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'refused %', left(NEW.content, 40); END $$;
        CREATE TRIGGER zz_echo BEFORE UPDATE ON file_chunks
          FOR EACH ROW EXECUTE FUNCTION zz_echo_content();
        ALTER TABLE file_chunks ENABLE ALWAYS TRIGGER zz_echo;`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({ check: 'bm25-probe', relation: BM25_INDEX, sqlstate: 'P0001' }),
      ]);
      // The row the probe rewrote begins 'topic'; that text must not survive into the report.
      expect(JSON.stringify(diagnosis)).not.toContain('topic');
      expect(diagnosis.findings[0]?.message).toMatch(/bm25 probe/u);
    });
  });
});

describe('relations and answers the diagnosis cannot check, or must not misread', () => {
  it('lists an index with no check for its access method as unchecked', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec('CREATE TABLE zz_am (n int); CREATE INDEX zz_am_brin ON zz_am USING brin (n)');
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.unchecked).toContainEqual({
        accessMethod: 'brin',
        reason: 'unsupported-access-method',
        relation: 'zz_am_brin',
        table: 'zz_am',
      });
    });
  });

  it('lists a bm25 index over an expression and an hnsw index with an unmapped operator class as unchecked', async () => {
    await withDatabase(untouched, async (db) => {
      await db.exec(`
        CREATE TABLE zz_shapes (body text, emb vector(3));
        CREATE INDEX zz_expr_bm25 ON zz_shapes USING bm25 ((body || 'x')) WITH (text_config=english);
        CREATE INDEX zz_l1_hnsw ON zz_shapes USING hnsw (emb vector_l1_ops);`);
      const diagnosis = await diagnose(db);
      expect(diagnosis.findings).toEqual([]);
      for (const relation of ['zz_expr_bm25', 'zz_l1_hnsw']) {
        expect(diagnosis.unchecked, relation).toContainEqual(
          expect.objectContaining({ reason: 'unsupported-index-definition', relation })
        );
      }
    });
  });

  it('lists a probed index as unchecked when the catalog returns no definition for it', async () => {
    await withDatabase(untouched, async (db) => {
      const diagnosis = await diagnose(
        answering(db, (sql) =>
          sql.includes('pg_get_indexdef(i.indexrelid, 1, true)') ? [] : undefined
        )
      );
      expect(diagnosis.findings).toEqual([]);
      expect(
        diagnosis.unchecked
          .filter(({ reason }) => reason === 'unsupported-index-definition')
          .map(({ relation }) => relation)
      ).toEqual(expect.arrayContaining([BM25_INDEX, HNSW_INDEX]));
    });
  });

  it('reports a heap problem that names no line pointer without an offset', async () => {
    await withDatabase(untouched, async (db) => {
      const diagnosis = await diagnose(
        answering(db, (sql, params) =>
          sql.includes('verify_heapam') && String(params?.[0]) === getBase().fileRecordsOid
            ? [{ blkno: '7', msg: 'page header is odd', offnum: null }]
            : undefined
        )
      );
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({
          check: 'heap',
          message: 'block 7: page header is odd',
          relation: 'file_records',
          sqlstate: null,
        }),
      ]);
    });
  });

  it('keeps a thrown value that is not an Error, and drops a code that is not a SQLSTATE', async () => {
    await withDatabase(untouched, async (db) => {
      const plain = await diagnose(
        failingBtreeCheck(db, PKEY_INDEX, 'plain text failure' as never)
      );
      expect(plain.findings).toEqual([
        expect.objectContaining({
          message: 'plain text failure',
          relation: PKEY_INDEX,
          sqlstate: null,
        }),
      ]);
      const odd = await diagnose(
        failingBtreeCheck(db, PKEY_INDEX, Object.assign(new Error('odd'), { code: 'not-a-code' }))
      );
      expect(odd.findings).toEqual([expect.objectContaining({ message: 'odd', sqlstate: null })]);
    });
  });

  it('turns a count that returns no row into a row-count finding with no count', async () => {
    await withDatabase(untouched, async (db) => {
      const diagnosis = await diagnose(
        answering(db, (sql) =>
          sql.includes('count(*)') && sql.includes('"file_records"') ? [] : undefined
        )
      );
      expect(diagnosis.findings).toEqual([
        expect.objectContaining({
          check: 'row-count',
          message: 'count(*) returned no row',
          relation: 'file_records',
        }),
      ]);
      expect(diagnosis.tables.find(({ table }) => table === 'file_records')).toMatchObject({
        rows: null,
      });
    });
  });

  it('resets the session settings, and still throws the original error, when the run fails for another reason', async () => {
    await withDatabase(untouched, async (db) => {
      const resets: string[] = [];
      const boom = new Error('classifier broke');
      const handle = answering(
        db,
        () => undefined,
        (sql) => {
          if (sql.startsWith('RESET')) {
            resets.push(sql);
            return Promise.reject(new Error('reset failed too'));
          }
          return db.exec(sql);
        }
      );
      await expect(
        diagnoseDatabaseIntegrity(handle, {
          classify: () => {
            throw boom;
          },
        })
      ).rejects.toBe(boom);
      expect(resets).toHaveLength(1);
    });
  });

  it('stops with the trap when the rollback after an ordinary probe failure hits one', async () => {
    await withDatabase(untouched, async (db) => {
      const trap = Object.assign(new Error('WebAssembly trap'), { name: 'PGliteFatalTrapError' });
      const handle = failingStatements(
        db,
        Object.assign(new Error('probe failed'), { code: 'XX001' }),
        HNSW_PROBE,
        (sql) => (sql === 'ROLLBACK' ? trap : undefined)
      );
      await expect(diagnose(handle)).rejects.toBe(trap);
    });
  });
});
