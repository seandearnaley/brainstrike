/**
 * pg_textsearch (BM25) Spike — PGlite 0.5.4 / Postgres 18.3
 *
 * Evaluates `@electric-sql/pglite-pg_textsearch` (Tiger Data's BM25 index AM,
 * compacts synchronously — no background worker, which is why PGlite can ship
 * it) as an upgrade for the LEXICAL arm of hybrid search, which today ranks
 * with `ts_rank` (no IDF term, no TF saturation — see
 * electron-file-chunk-repository.ts `searchByText`).
 *
 * This spike proves, against the real migration suite:
 * 1. The engine-extension set {vector, pg_trgm, pg_textsearch} coexists and the
 *    FULL migration suite still passes (PGLITE EXTENSION INVARIANT candidate).
 * 2. A `bm25` index builds on the real `file_chunks.content` column and serves
 *    ranked queries through `<@>` / `to_bm25query`.
 * 3. BM25's IDF weighting ranks a rare-term document first on a corpus where
 *    frequency-only `ts_rank` ordering is dominated by a stuffed common term —
 *    the quantified comparison is asserted, not just logged.
 *
 * If pg_textsearch graduates to production wiring, the loader must be added to
 * ALL PGlite construction sites (wasm-loader.ts, pglite-worker-entry.ts,
 * apps/desktop/src/db-main.ts) per docs/agents/database.md.
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';

const SPIKE_TIMEOUT_MS = 60_000;

/**
 * Corpus designed to discriminate IDF-aware ranking from frequency-only
 * ranking. Every document matches the SAME NUMBER of query terms (two of
 * "pipeline scheduler quaternion"), so pure match-counting cannot separate
 * them; what differs is WHICH terms match and how often:
 * - noise docs match the two UBIQUITOUS terms (pipeline, scheduler) at high
 *   frequency — ts_rank, having no corpus statistics, rewards exactly this;
 * - the target doc matches one ubiquitous term once plus the RARE term
 *   ("quaternion", one document in the corpus) once — near-zero signal to a
 *   frequency-only ranker, decisive IDF signal to BM25.
 */
const RARE_DOC_ID = 'chunk-rare';
const RARE_DOC =
  'The pipeline stage converts the rotation into a quaternion before interpolation begins.';
const NOISE_DOC_COUNT = 11;

function buildNoiseDoc(index: number): string {
  // "pipeline" x8 and "scheduler" x8 per noise doc — both query terms matched,
  // heavy term frequency, zero rare-term signal.
  const stuffed = Array.from(
    { length: 8 },
    (_, i) => `pipeline stage ${i} runs while the scheduler retries`
  ).join(' ');
  return `${stuffed} in build ${index}.`;
}

const BM25_QUERY = 'pipeline scheduler quaternion';
const TS_QUERY = 'pipeline OR scheduler OR quaternion';

interface RankedRow {
  id: string;
  score: number;
}

describe.skip('pg_textsearch BM25 spike (quarantined by migration 065)', () => {
  let db: PGlite;
  let migrationResult: Awaited<ReturnType<typeof runMigrations>>;

  // ALL shared setup lives here so each `it` is self-contained and the suite
  // survives `vitest -t <name>` filtering / order shuffling: migrations,
  // CREATE EXTENSION, corpus seed, and the bm25 index build.
  beforeAll(async () => {
    db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
    migrationResult = await runMigrations(db, { enableVector: true });
    if (!migrationResult.success) {
      throw new Error(`migrations failed: ${migrationResult.error}`);
    }
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_textsearch');

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ('spike-file', 'spike.md', '/spike.md', 1, $1, $1)`,
      [now]
    );
    const insertChunk = async (id: string, index: number, content: string): Promise<void> => {
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
         VALUES ($1, 'spike-file', $2, $3, $4, $5, $5)`,
        [id, index, content, `hash-${id}`, now]
      );
    };
    await insertChunk(RARE_DOC_ID, 0, RARE_DOC);
    for (let i = 0; i < NOISE_DOC_COUNT; i++) {
      await insertChunk(`chunk-noise-${i}`, i + 1, buildNoiseDoc(i));
    }

    // The migrated table already carries the STORED generated tsvector column
    // (migration 034) and its GIN index; the bm25 index must coexist with both.
    await db.exec(
      `CREATE INDEX file_chunks_bm25_spike_idx ON file_chunks
         USING bm25 (content) WITH (text_config='english')`
    );
  }, SPIKE_TIMEOUT_MS);

  afterAll(async () => {
    await db.close();
  });

  it('runs the FULL migration suite with pg_textsearch present in the engine set', () => {
    expect(migrationResult.success).toBe(true);
    expect(migrationResult.error).toBeUndefined();
  });

  it('creates the pg_textsearch extension alongside vector and pg_trgm', async () => {
    const result = await db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'pg_textsearch') ORDER BY extname"
    );
    expect(result.rows.map((r) => r.extname)).toEqual(['pg_textsearch', 'pg_trgm', 'vector']);
  });

  it('exposes the documented GUC surface', async () => {
    const result = await db.query<{ default_limit: string }>(
      "SELECT current_setting('pg_textsearch.default_limit') AS default_limit"
    );
    expect(result.rows[0]?.default_limit).toBe('1000');
  });

  it(
    'the bm25 index on the REAL migrated file_chunks.content serves <@> queries',
    async () => {
      const result = await db.query<RankedRow>(
        `SELECT id, (content <@> to_bm25query($1, 'file_chunks_bm25_spike_idx'))::float8 AS score
         FROM file_chunks
         ORDER BY content <@> to_bm25query($1, 'file_chunks_bm25_spike_idx')
         LIMIT 12`,
        [BM25_QUERY]
      );

      expect(result.rows.length).toBeGreaterThan(0);
      // BM25: rare-term document first, despite every noise doc carrying 8-10x
      // the common-term frequency.
      expect(result.rows[0]?.id).toBe(RARE_DOC_ID);
      // pg_textsearch returns NEGATIVE BM25 scores (more negative = better).
      for (const row of result.rows) {
        expect(row.score).toBeLessThan(0);
      }
      const rareScore = result.rows[0]?.score ?? 0;
      const runnerUpScore = result.rows[1]?.score ?? 0;
      expect(rareScore).toBeLessThan(runnerUpScore);
    },
    SPIKE_TIMEOUT_MS
  );

  it(
    'QUANTIFIED: BM25 beats ts_rank ordering on the IDF-discriminating corpus',
    async () => {
      // Same corpus, both rankers, OR-semantics so every document matches and
      // ORDERING (not match filtering) is what differs — mirrors how a weakly
      // ordered lexical list degrades RRF fusion in hybrid search.
      const bm25 = await db.query<{ id: string }>(
        `SELECT id FROM file_chunks
         ORDER BY content <@> to_bm25query($1, 'file_chunks_bm25_spike_idx')
         LIMIT 12`,
        [BM25_QUERY]
      );
      const tsRank = await db.query<{ id: string; rank: number }>(
        `SELECT id, ts_rank(content_tsvector, websearch_to_tsquery('english', $1))::float8 AS rank
         FROM file_chunks
         WHERE content_tsvector @@ websearch_to_tsquery('english', $1)
         ORDER BY rank DESC, id
         LIMIT 12`,
        [TS_QUERY]
      );

      const bm25Position = bm25.rows.findIndex((r) => r.id === RARE_DOC_ID) + 1;
      const tsRankPosition = tsRank.rows.findIndex((r) => r.id === RARE_DOC_ID) + 1;

      // Both rankers saw the full corpus.
      expect(bm25.rows).toHaveLength(NOISE_DOC_COUNT + 1);
      expect(tsRank.rows).toHaveLength(NOISE_DOC_COUNT + 1);

      // The quantified claim: BM25 puts the relevant rare-term chunk at #1;
      // frequency-only ts_rank buries it beneath the term-stuffed noise docs.
      expect(bm25Position).toBe(1);
      expect(tsRankPosition).toBeGreaterThan(1);

      // Surface the numbers in the test output for the spike write-up.
      console.info(
        `[bm25-spike] rare-doc rank — BM25: ${bm25Position}/12, ts_rank: ${tsRankPosition}/12`
      );
    },
    SPIKE_TIMEOUT_MS
  );
});
