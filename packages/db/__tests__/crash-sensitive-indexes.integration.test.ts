/**
 * BST-1871: crash-sensitive index rebuild.
 *
 * pg_textsearch 1.3.1's BM25 index free-space map is not WAL-logged, so a
 * SIGKILL can leave stale allocator state that a REINDEX clears. These tests run
 * the real catalog query and the real `REINDEX` on a fully migrated PGlite
 * (full engine-extension set) — nothing here mocks the thing under test except
 * the two failure cases, which wrap the real handle to inject the failure at the
 * exact statement boundary.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CRASH_SENSITIVE_INDEX_ACCESS_METHODS,
  type CrashSensitiveIndexDb,
  CrashSensitiveIndexRebuildError,
  listCrashSensitiveIndexes,
  rebuildCrashSensitiveIndexes,
} from '../src/crash-sensitive-indexes';
import { createMigratedTestDb } from './helpers/migrated-test-db';

const PRODUCTION_BM25_INDEX = 'idx_file_chunks_content_bm25';
// Mixed case AND an embedded double quote: the two things an unquoted or
// naively-quoted `REINDEX INDEX` would mangle.
const QUOTED_BM25_INDEX = 'Mixed"Case_bm25';
const FIXTURE_ROWS = 5000;
const FIXTURE_TIMEOUT_MS = 60_000;

async function seedChunks(db: PGlite, rows: number): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
     VALUES ('crash-file', 'crash.md', '/crash.md', 1, $1, $1)`,
    [now]
  );
  // 250 distinct topic words; chunk 42 is the only carrier of the rare term so
  // the post-rebuild search has one unambiguous top hit.
  await db.query(
    `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
     SELECT 'chunk-' || g, 'crash-file', g,
            CASE WHEN g = 42 THEN 'quaternion interpolation ' ELSE '' END
              || 'topic' || (g % 250) || ' ' || md5(g::text) || ' pipeline scheduler',
            'hash-' || g, $2, $2
     FROM generate_series(1, $1::int) AS g`,
    [rows, now]
  );
}

async function relfilenodeOf(db: PGlite, index: string): Promise<number> {
  const result = await db.query<{ relfilenode: number }>(
    `SELECT c.relfilenode::int AS relfilenode
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1`,
    [index]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`index ${index} not found`);
  }
  return row.relfilenode;
}

async function topBm25Hit(db: PGlite, indexName: string): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM file_chunks
     ORDER BY content <@> to_bm25query($1, $2)
     LIMIT 3`,
    ['quaternion', indexName]
  );
  return result.rows[0]?.id;
}

async function captureRebuildFailure(
  handle: CrashSensitiveIndexDb
): Promise<CrashSensitiveIndexRebuildError> {
  try {
    await rebuildCrashSensitiveIndexes(handle);
  } catch (error) {
    if (error instanceof CrashSensitiveIndexRebuildError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected rebuildCrashSensitiveIndexes to reject');
}

describe('crash-sensitive index rebuild (real migrated database)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('names bm25 as the only crash-sensitive access method', () => {
    expect(CRASH_SENSITIVE_INDEX_ACCESS_METHODS).toEqual(['bm25']);
  });

  it('lists exactly the production BM25 index, derived from the catalog', async () => {
    // The real schema also carries btree, GIN (pg_trgm, tsvector) and HNSW
    // indexes; none of them may appear.
    const indexCount = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'`
    );
    expect(indexCount.rows[0]?.count).toBeGreaterThan(20);

    const listed = await listCrashSensitiveIndexes(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      accessMethod: 'bm25',
      index: PRODUCTION_BM25_INDEX,
      schema: 'public',
      table: 'file_chunks',
    });
  });

  it('lists heap, toast and index bytes for the production BM25 index', async () => {
    await seedChunks(db, FIXTURE_ROWS);

    const [entry] = await listCrashSensitiveIndexes(db);

    // Short rows never leave the heap, so the toast relation exists but is empty.
    expect(entry?.heapBytes).toBeGreaterThan(0);
    expect(entry?.indexBytes).toBeGreaterThan(0);
    expect(entry?.toastBytes).toBe(0);
    for (const bytes of [entry?.heapBytes, entry?.indexBytes, entry?.toastBytes]) {
      expect(Number.isSafeInteger(bytes)).toBe(true);
    }
  });

  it('reports toastBytes for a table whose column is stored out of line', async () => {
    // 400 md5 digests are ~12.8 kB of hex text per row: over the 2 kB TOAST threshold even
    // after pglz compression, so every row's content lands in the toast relation.
    await db.exec(`
      CREATE TABLE toasted_notes (id int PRIMARY KEY, content text NOT NULL);
      INSERT INTO toasted_notes
        SELECT g, (SELECT string_agg(md5(g::text || '-' || i::text), '') FROM generate_series(1, 400) AS i)
        FROM generate_series(1, 50) AS g;
      CREATE INDEX toasted_notes_bm25 ON toasted_notes USING bm25 (content) WITH (text_config='english');
    `);

    const listed = await listCrashSensitiveIndexes(db);
    const entry = listed.find((candidate) => candidate.table === 'toasted_notes');

    expect(entry?.toastBytes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(entry?.toastBytes)).toBe(true);
    expect(entry?.heapBytes).toBeGreaterThan(0);
  });

  it('calls onBeforeIndex once per index, before its REINDEX, in name order', async () => {
    await seedChunks(db, 200);
    await db.exec(
      `CREATE INDEX "Mixed""Case_bm25" ON file_chunks USING bm25 (content) WITH (text_config='english')`
    );
    const events: string[] = [];
    const sizes: Record<string, { heapBytes: number; indexBytes: number }> = {};
    const recording: CrashSensitiveIndexDb = {
      exec: (sql) => {
        const reindexed = /^REINDEX INDEX "public"\."(?<name>.*)"$/u.exec(sql)?.groups?.['name'];
        events.push(`reindex:${reindexed?.replaceAll('""', '"') ?? sql}`);
        return db.exec(sql);
      },
      query: (sql, params) => db.query(sql, params),
    };

    await rebuildCrashSensitiveIndexes(recording, {
      onBeforeIndex: (entry) => {
        events.push(`before:${entry.index}`);
        sizes[entry.index] = { heapBytes: entry.heapBytes, indexBytes: entry.indexBytes };
      },
    });

    expect(events).toEqual([
      `before:${QUOTED_BM25_INDEX}`,
      `reindex:${QUOTED_BM25_INDEX}`,
      `before:${PRODUCTION_BM25_INDEX}`,
      `reindex:${PRODUCTION_BM25_INDEX}`,
    ]);
    // The hook receives the sizes read from the catalog before the pass started.
    expect(sizes[PRODUCTION_BM25_INDEX]?.heapBytes).toBeGreaterThan(0);
    expect(sizes[PRODUCTION_BM25_INDEX]?.indexBytes).toBeGreaterThan(0);
  });

  it('never reaches a REINDEX when onBeforeIndex throws, and surfaces the hook error unwrapped', async () => {
    const boom = new Error('phase report could not be posted');
    const statements: string[] = [];
    const recording: CrashSensitiveIndexDb = {
      exec: (sql) => {
        statements.push(sql);
        return db.exec(sql);
      },
      query: (sql, params) => db.query(sql, params),
    };

    await expect(
      rebuildCrashSensitiveIndexes(recording, {
        onBeforeIndex: () => {
          throw boom;
        },
      })
    ).rejects.toBe(boom);
    expect(statements).toEqual([]);
  });

  it(
    'rebuilds the production BM25 index (new relfilenode) and keeps BM25 search working',
    async () => {
      await seedChunks(db, FIXTURE_ROWS);
      expect(await topBm25Hit(db, PRODUCTION_BM25_INDEX)).toBe('chunk-42');
      const before = await relfilenodeOf(db, PRODUCTION_BM25_INDEX);

      const result = await rebuildCrashSensitiveIndexes(db);

      // REINDEX writes a fresh relation file: a changed relfilenode proves the
      // rebuild ran rather than the call merely returning a result.
      expect(await relfilenodeOf(db, PRODUCTION_BM25_INDEX)).not.toBe(before);
      expect(result.rebuilt).toHaveLength(1);
      expect(result.rebuilt[0]).toMatchObject({
        accessMethod: 'bm25',
        index: PRODUCTION_BM25_INDEX,
        schema: 'public',
        table: 'file_chunks',
      });
      expect(result.rebuilt[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(result.rebuilt[0]?.durationMs ?? 0);
      // The rebuilt index still serves ranked queries over the full table.
      expect(await topBm25Hit(db, PRODUCTION_BM25_INDEX)).toBe('chunk-42');
    },
    FIXTURE_TIMEOUT_MS
  );

  it('rebuilds a mixed-case index whose name contains a double quote, in name order', async () => {
    await seedChunks(db, 200);
    await db.exec(
      `CREATE INDEX "Mixed""Case_bm25" ON file_chunks USING bm25 (content) WITH (text_config='english')`
    );
    const before = await relfilenodeOf(db, QUOTED_BM25_INDEX);
    const productionBefore = await relfilenodeOf(db, PRODUCTION_BM25_INDEX);
    // Catalog names sort in C collation: uppercase `M` precedes `i`.
    const expectedOrder = [QUOTED_BM25_INDEX, PRODUCTION_BM25_INDEX];
    expect((await listCrashSensitiveIndexes(db)).map((entry) => entry.index)).toEqual(
      expectedOrder
    );

    let tick = 0;
    const result = await rebuildCrashSensitiveIndexes(db, {
      clock: () => {
        tick += 10;
        return tick;
      },
    });

    expect(result.rebuilt.map((entry) => entry.index)).toEqual(expectedOrder);
    expect(await relfilenodeOf(db, QUOTED_BM25_INDEX)).not.toBe(before);
    expect(await relfilenodeOf(db, PRODUCTION_BM25_INDEX)).not.toBe(productionBefore);
    expect(await topBm25Hit(db, QUOTED_BM25_INDEX)).toBe('chunk-42');
    // The injected clock is what durations are computed from: two consecutive
    // reads bracket each REINDEX, and the total spans the whole pass.
    expect(result.rebuilt.map((entry) => entry.durationMs)).toEqual([10, 10]);
    expect(result.totalDurationMs).toBe(50);
  });

  it('includes crash-sensitive indexes outside the public schema and reindexes them schema-qualified', async () => {
    await db.exec(`
      CREATE SCHEMA extra;
      CREATE TABLE extra.notes (id text PRIMARY KEY, content text NOT NULL);
      INSERT INTO extra.notes VALUES ('n1', 'quaternion rotation'), ('n2', 'pipeline stage');
      CREATE INDEX notes_bm25 ON extra.notes USING bm25 (content) WITH (text_config='english');
    `);
    const relfilenode = async (): Promise<number> => {
      const result = await db.query<{ relfilenode: number }>(
        `SELECT 'extra.notes_bm25'::regclass::oid AS oid, c.relfilenode::int AS relfilenode
         FROM pg_class c WHERE c.oid = 'extra.notes_bm25'::regclass`
      );
      return result.rows[0]?.relfilenode ?? -1;
    };
    const before = await relfilenode();

    const listed = await listCrashSensitiveIndexes(db);
    expect(listed.map((entry) => `${entry.schema}.${entry.index}`)).toEqual([
      'extra.notes_bm25',
      `public.${PRODUCTION_BM25_INDEX}`,
    ]);

    const result = await rebuildCrashSensitiveIndexes(db);
    expect(result.rebuilt.map((entry) => entry.schema)).toEqual(['extra', 'public']);
    expect(await relfilenode()).not.toBe(before);
  });

  it('returns an empty result and issues no REINDEX when nothing is crash-sensitive', async () => {
    await db.exec(`DROP INDEX ${PRODUCTION_BM25_INDEX}`);
    const statements: string[] = [];
    const recording: CrashSensitiveIndexDb = {
      exec: (sql) => {
        statements.push(sql);
        return db.exec(sql);
      },
      query: (sql, params) => db.query(sql, params),
    };

    const result = await rebuildCrashSensitiveIndexes(recording);

    expect(result.rebuilt).toEqual([]);
    expect(statements).toEqual([]);
  });

  it('propagates a REINDEX rejection naming the index, without reporting partial success', async () => {
    await db.exec(
      `CREATE INDEX "Mixed""Case_bm25" ON file_chunks USING bm25 (content) WITH (text_config='english')`
    );
    const boom = new Error('injected REINDEX failure');
    const failing: CrashSensitiveIndexDb = {
      exec: (sql) => {
        if (sql.includes(PRODUCTION_BM25_INDEX)) {
          return Promise.reject(boom);
        }
        return db.exec(sql);
      },
      query: (sql, params) => db.query(sql, params),
    };

    const failure = await captureRebuildFailure(failing);

    expect(failure.index).toBe(PRODUCTION_BM25_INDEX);
    expect(failure.message).toContain(PRODUCTION_BM25_INDEX);
    expect(failure.cause).toBe(boom);
  });

  it('surfaces the real Postgres error when an index vanishes between list and rebuild', async () => {
    const dropAfterList: CrashSensitiveIndexDb = {
      exec: (sql) => db.exec(sql),
      query: async <TRecord>(sql: string, params?: unknown[]) => {
        const result = await db.query<TRecord>(sql, params);
        await db.exec(`DROP INDEX ${PRODUCTION_BM25_INDEX}`);
        return result;
      },
    };

    const failure = await captureRebuildFailure(dropAfterList);

    expect(failure.index).toBe(PRODUCTION_BM25_INDEX);
    expect(failure.message).toContain(PRODUCTION_BM25_INDEX);
    expect(String(failure.cause)).toMatch(/does not exist/u);
  });
});
