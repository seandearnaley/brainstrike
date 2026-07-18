/**
 * BM25 adoption — EMPIRICAL GATE (Step 1 of the approved plan)
 *
 * Decides, with measurements, whether the match-preserving ordering swap can
 * ship as designed:
 * - Can `content <@> to_bm25query(...)` be evaluated as a PLAIN EXPRESSION
 *   under the exact production query shape (tsvector WHERE + rootIds subquery
 *   + expression in SELECT + ROW_NUMBER window + ts_headline + LIMIT), rather
 *   than only via a bm25 index-ordered scan? (If not → LEFT-JOIN fallback.)
 * - Does `to_bm25query` tolerate websearch-style user input that
 *   `websearch_to_tsquery` accepts? (If not → sanitize or gate.)
 * - Does the bm25 index score rows inserted AFTER the build? (If not → the
 *   whole feature is dead; file_chunks churns constantly.)
 * - Does `pg_textsearch.default_limit` (1000-doc scoring cap) corrupt the
 *   filtered-plan ordering when far more than 1000 rows match?
 * - Do scores stay non-positive for near-ubiquitous terms (rank = -score must
 *   stay >= 0 for the JS threshold filter's direction)?
 * - How long does the index build take at ~50k chunks (inline-vs-deferred
 *   migration budget: inline if within ~15–20 s at 100k)?
 *
 * The numbers this file logs (`[bm25-gate] ...`) are the recorded evidence the
 * migration + repository swap steps cite.
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';

const GATE_TIMEOUT_MS = 240_000;

/** Corpus scale — large enough for planner realism + the default_limit probe. */
const FILE_COUNT = 2000;
const CHUNKS_PER_FILE = 25; // 50k chunks total
const TOTAL_CHUNKS = FILE_COUNT * CHUNKS_PER_FILE;
const ROOT_IDS = ['root-a', 'root-b', 'root-c'] as const;

/** Inline-build budget from the plan (HNSW-equivalent ceiling, foreground-free). */
const INLINE_BUILD_BUDGET_MS = 20_000;

const BM25_INDEX = 'idx_file_chunks_content_bm25_gate';

/**
 * The EXACT production query shape from fullTextSearch (file-chunk-repository)
 * with only the rank expression swapped to negated BM25 — this is what the
 * repositories will run after the swap. $1 regconfig, $2 query, $3 rootIds.
 */
const PRODUCTION_SHAPE_SQL = `
  SELECT
    id,
    file_record_id,
    -(content <@> to_bm25query($2, '${BM25_INDEX}'))::float8 AS fts_rank,
    ts_headline($1::regconfig, content, websearch_to_tsquery($1::regconfig, $2),
      'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') AS headline,
    ROW_NUMBER() OVER (
      ORDER BY -(content <@> to_bm25query($2, '${BM25_INDEX}')) DESC, id
    ) AS position
  FROM file_chunks
  WHERE content_tsvector IS NOT NULL
    AND content_tsvector @@ websearch_to_tsquery($1::regconfig, $2)
    AND file_record_id IN (SELECT id FROM file_records WHERE root_id = ANY($3::text[]))
  ORDER BY fts_rank DESC, id
  LIMIT $4
`;

interface GateRow {
  file_record_id: string;
  fts_rank: number;
  headline: string;
  id: string;
  position: string;
}

describe.skip('BM25 empirical gate (pg_textsearch is quarantined by migration 065)', () => {
  let db: PGlite;
  let indexBuildMs = -1;

  beforeAll(async () => {
    db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
    const migrated = await runMigrations(db, { enableVector: true });
    if (!migrated.success) {
      throw new Error(`migrations failed: ${migrated.error}`);
    }
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_textsearch');

    // Seed roots + file_records + 50k chunks with a controlled vocabulary:
    // - "pipeline" in EVERY chunk (ubiquitous — near-zero IDF, sign probe)
    // - "scheduler" in every second chunk (common — default_limit probe: 25k matches)
    // - "quaternion" in EXACTLY ONE chunk inside root-a (rare — ordering target)
    // - per-chunk filler tokens derived from the series index (vocabulary spread)
    await db.exec(`
      INSERT INTO roots (id, kind, display_name, path)
      VALUES ${ROOT_IDS.map((r) => `('${r}', 'path', '${r}', '/${r}')`).join(', ')}
    `);
    await db.exec(`
      INSERT INTO file_records (id, name, path, root_id, size, created_at, updated_at)
      SELECT
        'file-' || s,
        'file-' || s || '.md',
        '/f/' || s || '.md',
        (ARRAY['root-a','root-b','root-c'])[1 + (s % 3)],
        100,
        now()::text,
        now()::text
      FROM generate_series(0, ${FILE_COUNT - 1}) AS s
    `);
    await db.exec(`
      INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
      SELECT
        'chunk-' || s,
        'file-' || (s / ${CHUNKS_PER_FILE}),
        s % ${CHUNKS_PER_FILE},
        'the pipeline stage token' || (s % 977) || ' handles batch token' || (s % 613)
          || CASE WHEN s % 2 = 0 THEN ' while the scheduler retries the queue' ELSE ' without further delay' END
          || CASE WHEN s = 42 THEN ' converting the rotation into a quaternion before interpolation' ELSE '' END,
        md5('chunk-' || s),
        now()::text,
        now()::text
      FROM generate_series(0, ${TOTAL_CHUNKS - 1}) AS s
    `);
    await db.exec('ANALYZE file_chunks; ANALYZE file_records');

    // Timed index build lives in setup so every `it` is self-contained under
    // `vitest -t` filtering; test (f) asserts the recorded duration.
    const buildStartedAt = performance.now();
    await db.exec(
      `CREATE INDEX ${BM25_INDEX} ON file_chunks USING bm25 (content) WITH (text_config='english')`
    );
    indexBuildMs = Math.round(performance.now() - buildStartedAt);
  }, GATE_TIMEOUT_MS);

  afterAll(async () => {
    await db.close();
  });

  it(`(f) built the bm25 index on ${TOTAL_CHUNKS} chunks within the inline budget`, () => {
    console.info(
      `[bm25-gate] index build: ${indexBuildMs}ms for ${TOTAL_CHUNKS} chunks (budget ${INLINE_BUILD_BUDGET_MS}ms)`
    );
    expect(indexBuildMs).toBeGreaterThanOrEqual(0);
    expect(indexBuildMs).toBeLessThan(INLINE_BUILD_BUDGET_MS);
  });

  it(
    '(a) evaluates <@> as a plain expression under the exact production shape',
    async () => {
      // chunk-42 lives in file-1 (42 / 25 = 1) → file-1 % 3 = root-b... compute:
      // file id = floor(42/25) = 1; root = ARRAY[...][1 + (1 % 3)] = index 2 = 'root-b'.
      const result = await db.query<GateRow>(PRODUCTION_SHAPE_SQL, [
        'english',
        'pipeline quaternion',
        ['root-b'],
        10,
      ]);

      expect(result.rows.length).toBeGreaterThan(0);
      // The rare-term chunk must be rank #1 within its root — the whole point
      // of the swap, now under the real filtered plan.
      expect(result.rows[0]?.id).toBe('chunk-42');
      // Negated-BM25 rank: strictly positive for the rare-term doc, and the
      // list must be ordered rank-descending with correct window positions.
      const first = result.rows[0]?.fts_rank ?? 0;
      expect(first).toBeGreaterThan(0);
      for (let i = 1; i < result.rows.length; i++) {
        const prev = result.rows[i - 1]?.fts_rank ?? 0;
        const curr = result.rows[i]?.fts_rank ?? 0;
        expect(curr).toBeLessThanOrEqual(prev);
        expect(Number(result.rows[i]?.position)).toBe(i + 1);
      }
      // Headline machinery is untouched by the swap and must still mark terms.
      expect(result.rows[0]?.headline).toContain('<mark>');
      // rootIds scoping intact: every hit belongs to root-b files.
      const scoped = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM file_records
         WHERE id = ANY($1::text[]) AND root_id <> 'root-b'`,
        [result.rows.map((r) => r.file_record_id)]
      );
      expect(scoped.rows[0]?.count).toBe('0');
    },
    GATE_TIMEOUT_MS
  );

  it(
    '(a2) filtered-plan latency at 50k chunks is sane (record the number)',
    async () => {
      const startedAt = performance.now();
      await db.query<GateRow>(PRODUCTION_SHAPE_SQL, [
        'english',
        'scheduler pipeline',
        [...ROOT_IDS],
        50,
      ]);
      const elapsedMs = Math.round(performance.now() - startedAt);
      const plan = await db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (FORMAT TEXT) ${PRODUCTION_SHAPE_SQL}`,
        ['english', 'scheduler pipeline', [...ROOT_IDS], 50]
      );
      console.info(
        `[bm25-gate] filtered-plan query: ${elapsedMs}ms over ${TOTAL_CHUNKS} chunks (~25k matches)\n` +
          plan.rows.map((r) => `[bm25-gate]   ${Object.values(r)[0]}`).join('\n')
      );
      // Generous CI bound — the recorded number is the real deliverable.
      expect(elapsedMs).toBeLessThan(5000);
    },
    GATE_TIMEOUT_MS
  );

  it(
    '(b) to_bm25query tolerates every websearch-style input websearch_to_tsquery accepts',
    async () => {
      const inputs = [
        '"quoted phrase search"',
        '-deprecated',
        'foo OR bar',
        'auth -legacy "exact phrase" OR fallback',
        '...!!!???',
        '(((',
        'héllo wörld ünïcode ßearch',
        'a'.repeat(4000),
        "it's a contraction; also: punctuation, everywhere!",
      ];
      const failures: { input: string; error: string }[] = [];
      for (const input of inputs) {
        try {
          await db.query(PRODUCTION_SHAPE_SQL, ['english', input, [...ROOT_IDS], 5]);
        } catch (error) {
          failures.push({
            error: error instanceof Error ? error.message : String(error),
            input: input.length > 40 ? `${input.slice(0, 40)}…` : input,
          });
        }
      }
      console.info(`[bm25-gate] fuzz: ${inputs.length - failures.length}/${inputs.length} ok`);
      expect(failures).toEqual([]);
    },
    GATE_TIMEOUT_MS
  );

  it(
    '(c) scores rows inserted, updated, and surviving deletes AFTER the index build',
    async () => {
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
         VALUES ('chunk-post-build', 'file-0', 999, 'the pipeline meets a zeppelin at dawn', 'hash-post', now()::text, now()::text)`
      );
      const afterInsert = await db.query<GateRow>(PRODUCTION_SHAPE_SQL, [
        'english',
        'zeppelin',
        [...ROOT_IDS],
        5,
      ]);
      expect(afterInsert.rows[0]?.id).toBe('chunk-post-build');
      expect(afterInsert.rows[0]?.fts_rank).toBeGreaterThan(0);

      await db.query(
        `UPDATE file_chunks SET content = 'the pipeline meets a dirigible at dusk' WHERE id = 'chunk-post-build'`
      );
      const afterUpdate = await db.query<GateRow>(PRODUCTION_SHAPE_SQL, [
        'english',
        'dirigible',
        [...ROOT_IDS],
        5,
      ]);
      expect(afterUpdate.rows[0]?.id).toBe('chunk-post-build');
      const staleTerm = await db.query<GateRow>(PRODUCTION_SHAPE_SQL, [
        'english',
        'zeppelin',
        [...ROOT_IDS],
        5,
      ]);
      expect(staleTerm.rows).toHaveLength(0);

      await db.query(`DELETE FROM file_chunks WHERE id = 'chunk-post-build'`);
      const afterDelete = await db.query<GateRow>(PRODUCTION_SHAPE_SQL, [
        'english',
        'dirigible',
        [...ROOT_IDS],
        5,
      ]);
      expect(afterDelete.rows).toHaveLength(0);
    },
    GATE_TIMEOUT_MS
  );

  it(
    '(d) ordering survives the default_limit scoring cap with ~25k matching rows',
    async () => {
      // "scheduler" matches ~25k rows — far past pg_textsearch.default_limit
      // (1000). If expression evaluation silently zeroes scores past the cap,
      // the capped ordering diverges from an uncapped run.
      const capped = await db.query<GateRow>(PRODUCTION_SHAPE_SQL, [
        'english',
        'scheduler',
        [...ROOT_IDS],
        20,
      ]);
      expect(capped.rows).toHaveLength(20);
      for (const row of capped.rows) {
        expect(row.fts_rank).toBeGreaterThan(0);
      }

      const uncapped = await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL pg_textsearch.default_limit = 100000');
        return await tx.query<GateRow>(PRODUCTION_SHAPE_SQL, [
          'english',
          'scheduler',
          [...ROOT_IDS],
          20,
        ]);
      });
      const cappedIds = capped.rows.map((r) => r.id);
      const uncappedIds = uncapped.rows.map((r) => r.id);
      console.info(
        `[bm25-gate] default_limit probe: capped==uncapped top-20 ordering: ${
          JSON.stringify(cappedIds) === JSON.stringify(uncappedIds)
        }`
      );
      expect(cappedIds).toEqual(uncappedIds);
    },
    GATE_TIMEOUT_MS
  );

  it(
    '(e) rank = -score stays >= 0 for a near-ubiquitous term (threshold direction holds)',
    async () => {
      // "pipeline" is in EVERY chunk — worst case for BM25 IDF sign behavior.
      const result = await db.query<GateRow>(PRODUCTION_SHAPE_SQL, [
        'english',
        'pipeline',
        [...ROOT_IDS],
        50,
      ]);
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(row.fts_rank).toBeGreaterThanOrEqual(0);
      }
      console.info(
        `[bm25-gate] ubiquitous-term rank range: ${result.rows.at(-1)?.fts_rank} .. ${result.rows[0]?.fts_rank}`
      );
    },
    GATE_TIMEOUT_MS
  );
});
