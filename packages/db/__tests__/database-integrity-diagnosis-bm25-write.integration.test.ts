/**
 * BST-1877 L1: the bm25 probe's write half: which other indexes it needs verified first (and that
 * their order does not matter), which write errors are the table's own rule and which are damage,
 * and the names pg_textsearch cannot resolve. Built with `helpers/diagnosis-fixture.ts`; the other
 * probe cases are in `database-integrity-diagnosis-probes.integration.test.ts`.
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { CrashSensitiveIndexDb } from '../src/crash-sensitive-indexes.js';
import {
  BM25_INDEX,
  diagnose,
  failingStatements,
  recording,
  registerDiagnosisFixture,
  untouched,
  withDatabase,
} from './helpers/diagnosis-fixture.js';

registerDiagnosisFixture();

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
