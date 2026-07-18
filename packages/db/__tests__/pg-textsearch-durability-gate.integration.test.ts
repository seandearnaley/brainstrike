/**
 * Opt-in pg_textsearch durability qualification gate.
 *
 * This deliberately creates a BM25 index outside Brainstrike's migration
 * suite so the extension can be qualified independently of application data.
 * Run before changing the engine version accepted by migration 066:
 *
 *   pnpm --filter @brainstrike/db test:pg-textsearch-durability
 *
 * The gate submits each cycle's insert, update, delete, BM25 search, and VACUUM
 * statements as a rotated burst. PGlite serializes those statements through
 * one WASM Postgres instance. The gate then repeatedly closes and reopens the
 * same on-disk store. A timeout bounds every workload cycle so a broken
 * extension cannot leave the qualification command looking idle indefinitely.
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { describe, expect, it } from 'vitest';
import { QUALIFIED_PG_TEXTSEARCH_VERSION } from '../src/pg-textsearch-compatibility';
import { createPGliteTestDataDir } from './test-data-dir';

const GATE_ENABLED = process.env.TEST_ENABLE_PG_TEXTSEARCH_DURABILITY === 'true';
const DEFAULT_CYCLE_COUNT = 48;
const DEFAULT_ROWS_PER_WRITER = 250;
const DEFAULT_WRITER_COUNT = 4;
const DEFAULT_REOPEN_INTERVAL = 4;
const DEFAULT_CYCLE_TIMEOUT_MS = 60_000;
const GATE_TIMEOUT_MS = 10 * 60_000;
const BM25_INDEX_NAME = 'pg_textsearch_durability_docs_bm25';
const MAX_INDEXED_ROW_COUNT = 100_000;

function readBoundedInteger(
  environmentName: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  const rawValue = process.env[environmentName];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new Error(
      `${environmentName} must be an integer from ${minimum} through ${maximum}; received ${JSON.stringify(rawValue)}`
    );
  }
  return parsedValue;
}

const CYCLE_COUNT = GATE_ENABLED
  ? readBoundedInteger('PG_TEXTSEARCH_DURABILITY_CYCLES', DEFAULT_CYCLE_COUNT, 4, 200)
  : DEFAULT_CYCLE_COUNT;
const ROWS_PER_WRITER = GATE_ENABLED
  ? readBoundedInteger(
      'PG_TEXTSEARCH_DURABILITY_ROWS_PER_WRITER',
      DEFAULT_ROWS_PER_WRITER,
      10,
      1000
    )
  : DEFAULT_ROWS_PER_WRITER;
const WRITER_COUNT = GATE_ENABLED
  ? readBoundedInteger('PG_TEXTSEARCH_DURABILITY_WRITERS', DEFAULT_WRITER_COUNT, 2, 16)
  : DEFAULT_WRITER_COUNT;
const REOPEN_INTERVAL = GATE_ENABLED
  ? readBoundedInteger(
      'PG_TEXTSEARCH_DURABILITY_REOPEN_INTERVAL',
      DEFAULT_REOPEN_INTERVAL,
      1,
      CYCLE_COUNT
    )
  : DEFAULT_REOPEN_INTERVAL;
const CYCLE_TIMEOUT_MS = GATE_ENABLED
  ? readBoundedInteger(
      'PG_TEXTSEARCH_DURABILITY_CYCLE_TIMEOUT_MS',
      DEFAULT_CYCLE_TIMEOUT_MS,
      5000,
      300_000
    )
  : DEFAULT_CYCLE_TIMEOUT_MS;
const MAX_POSSIBLE_ROW_COUNT = WRITER_COUNT * ROWS_PER_WRITER * (CYCLE_COUNT + 1);

if (GATE_ENABLED && MAX_POSSIBLE_ROW_COUNT > MAX_INDEXED_ROW_COUNT) {
  throw new Error(
    `The configured pg_textsearch durability workload can create ${MAX_POSSIBLE_ROW_COUNT} rows, exceeding pg_textsearch.default_limit=${MAX_INDEXED_ROW_COUNT}; reduce cycles, writers, or rows per writer so the BM25-backed integrity count covers the whole heap`
  );
}

interface CountRow {
  row_count: string;
}

interface IndexedCountRow {
  indexed_row_count: string;
}

interface ExtensionVersionRow {
  extversion: string;
}

interface IndexStateRow {
  indisready: boolean;
  indisvalid: boolean;
}

interface QueryPlanRow {
  'QUERY PLAN': string;
}

interface RankedRow {
  id: string;
}

interface RevisionRow {
  max_revision: number;
}

function openDatabase(dataDir: string): PGlite {
  return new PGlite({
    dataDir,
    extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
  });
}

async function configureStressThresholds(db: PGlite): Promise<void> {
  // Accepted fast workloads can be too small for the cost-based planner to
  // prefer BM25 on its own. The gate must traverse the index at every size.
  await db.exec(`
    SET enable_seqscan = off;
    SET pg_textsearch.bulk_load_threshold = 100;
    SET pg_textsearch.memtable_pages_threshold = 2;
    SET pg_textsearch.segments_per_level = 2;
    SET pg_textsearch.default_limit = ${MAX_INDEXED_ROW_COUNT};
  `);
}

async function runWithTimeout<T>(label: string, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      didTimeout = true;
      reject(new Error(`${label} exceeded the ${CYCLE_TIMEOUT_MS}ms durability-gate timeout`));
    }, CYCLE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } catch (error) {
    if (didTimeout) {
      // PGlite cannot cancel statements already queued in its single WASM
      // Postgres instance. Explicitly observe any later rejection while the
      // caller performs best-effort database cleanup after the bounded failure.
      void operation.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function insertWriterBatch(db: PGlite, cycle: number, writer: number): Promise<void> {
  await db.query(
    `INSERT INTO durability_docs (id, writer, revision, content)
     SELECT
       ($1::bigint * 1000000000) + ($2::bigint * 1000000) + sequence,
       $2::integer,
       $1::integer,
       'scheduler recovery cycle ' || $1::text
         || ' writer ' || $2::text
         || ' document ' || sequence::text
     FROM generate_series(1, $3::integer) AS sequence`,
    [cycle, writer, ROWS_PER_WRITER]
  );
}

async function updateWriterRows(db: PGlite, cycle: number, writer: number): Promise<void> {
  await db.query(
    `UPDATE durability_docs
     SET
       revision = $1::integer,
       content = content || ' revised scheduler recovery ' || $1::text
     WHERE writer = $2::integer
       AND id % 11 = $1::bigint % 11`,
    [cycle, writer]
  );
}

async function deleteAgedRows(db: PGlite, cycle: number): Promise<void> {
  await db.query(
    `DELETE FROM durability_docs
     WHERE revision < $1::integer - 3
       AND id % 29 = $1::bigint % 29`,
    [cycle]
  );
}

async function searchBm25(db: PGlite): Promise<void> {
  const result = await db.query<RankedRow>(
    `SELECT id
     FROM durability_docs
     ORDER BY content <@> to_bm25query(
       'scheduler recovery',
       '${BM25_INDEX_NAME}'
     )
     LIMIT 20`
  );
  expect(result.rows).toHaveLength(20);
}

function createCycleOperations(db: PGlite, cycle: number): Array<() => Promise<unknown>> {
  const operations: Array<() => Promise<unknown>> = [
    ...Array.from(
      { length: WRITER_COUNT },
      (_value, writer) => () => insertWriterBatch(db, cycle, writer)
    ),
    ...Array.from(
      { length: WRITER_COUNT },
      (_value, writer) => () => updateWriterRows(db, cycle, writer)
    ),
    () => deleteAgedRows(db, cycle),
    () => searchBm25(db),
    () => db.exec('VACUUM (ANALYZE) durability_docs'),
  ];
  const rotation = cycle % operations.length;
  return [...operations.slice(rotation), ...operations.slice(0, rotation)];
}

async function assertReopenIntegrity(db: PGlite, expectedRevision: number): Promise<number> {
  await configureStressThresholds(db);
  const counts = await db.query<CountRow>(
    'SELECT count(*)::text AS row_count FROM durability_docs'
  );
  const indexedCounts = await db.query<IndexedCountRow>(
    `SELECT count(*)::text AS indexed_row_count
     FROM (
       SELECT id
       FROM durability_docs
       ORDER BY content <@> to_bm25query(
         'scheduler recovery',
         '${BM25_INDEX_NAME}'
       )
       LIMIT ${MAX_INDEXED_ROW_COUNT}
     ) AS bm25_rows`
  );
  const indexedCountPlan = await db.query<QueryPlanRow>(
    `EXPLAIN (COSTS OFF)
     SELECT id
     FROM durability_docs
     ORDER BY content <@> to_bm25query(
       'scheduler recovery',
       '${BM25_INDEX_NAME}'
     )
     LIMIT ${MAX_INDEXED_ROW_COUNT}`
  );
  const revisions = await db.query<RevisionRow>(
    'SELECT max(revision)::integer AS max_revision FROM durability_docs'
  );
  const indexState = await db.query<IndexStateRow>(
    `SELECT index.indisready, index.indisvalid
     FROM pg_index AS index
     WHERE index.indexrelid = '${BM25_INDEX_NAME}'::regclass`
  );
  const rowCount = Number(counts.rows[0]?.row_count);
  const indexedRowCount = Number(indexedCounts.rows[0]?.indexed_row_count);

  expect(Number.isSafeInteger(rowCount)).toBe(true);
  expect(rowCount).toBeGreaterThan(WRITER_COUNT * ROWS_PER_WRITER);
  expect(indexedCountPlan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
    `Index Scan using ${BM25_INDEX_NAME}`
  );
  expect(indexedRowCount).toBe(rowCount);
  expect(revisions.rows).toEqual([{ max_revision: expectedRevision }]);
  expect(indexState.rows).toEqual([{ indisready: true, indisvalid: true }]);
  await searchBm25(db);

  return rowCount;
}

describe.skipIf(!GATE_ENABLED)('pg_textsearch BM25 durability qualification gate', () => {
  it(
    'survives sustained rotated writes, VACUUM, searches, checkpoints, and reopens',
    async () => {
      const dataDir = createPGliteTestDataDir('pglite-pg-textsearch-durability');
      let db: PGlite | null = openDatabase(dataDir);

      try {
        await db.exec(`
          CREATE EXTENSION pg_textsearch;
          CREATE TABLE durability_docs (
            id bigint PRIMARY KEY,
            writer integer NOT NULL,
            revision integer NOT NULL,
            content text NOT NULL
          );
        `);
        await configureStressThresholds(db);
        const extensionVersion = await db.query<ExtensionVersionRow>(
          "SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch'"
        );
        const actualExtensionVersion = extensionVersion.rows[0]?.extversion;
        if (actualExtensionVersion !== QUALIFIED_PG_TEXTSEARCH_VERSION) {
          throw new Error(
            `Expected qualified pg_textsearch ${QUALIFIED_PG_TEXTSEARCH_VERSION}, received ${actualExtensionVersion ?? '<missing>'}`
          );
        }
        const initialDb = db;
        await Promise.all(
          Array.from({ length: WRITER_COUNT }, (_value, writer) =>
            insertWriterBatch(initialDb, 0, writer)
          )
        );
        await db.exec(
          `CREATE INDEX ${BM25_INDEX_NAME}
           ON durability_docs USING bm25 (content)
           WITH (text_config='english')`
        );
        await db.exec('CHECKPOINT');

        console.info(
          `[pg-textsearch-durability] started: extension=${actualExtensionVersion}, cycles=${CYCLE_COUNT}, writers=${WRITER_COUNT}, rowsPerWriter=${ROWS_PER_WRITER}, reopenEvery=${REOPEN_INTERVAL}`
        );

        for (let cycle = 1; cycle <= CYCLE_COUNT; cycle += 1) {
          const activeDb = db;
          if (!activeDb) {
            throw new Error(`Database is unavailable at durability cycle ${cycle}`);
          }

          console.info(
            `[pg-textsearch-durability] cycle ${cycle}/${CYCLE_COUNT}: running rotated writes, search, and VACUUM`
          );
          await runWithTimeout(
            `pg_textsearch durability cycle ${cycle}/${CYCLE_COUNT}`,
            (async () => {
              await Promise.all(
                createCycleOperations(activeDb, cycle).map((operation) => operation())
              );
              await activeDb.exec('CHECKPOINT');

              if (cycle % REOPEN_INTERVAL === 0 || cycle === CYCLE_COUNT) {
                console.info(
                  `[pg-textsearch-durability] cycle ${cycle}/${CYCLE_COUNT}: checkpoint complete; reopening store`
                );
                db = null;
                await activeDb.close();
                db = openDatabase(dataDir);
                const rowCount = await assertReopenIntegrity(db, cycle);
                console.info(
                  `[pg-textsearch-durability] cycle ${cycle}/${CYCLE_COUNT}: reopen verified ${rowCount} rows`
                );
              } else {
                console.info(`[pg-textsearch-durability] cycle ${cycle}/${CYCLE_COUNT}: complete`);
              }
            })()
          );
        }
      } finally {
        await db?.close();
      }
    },
    GATE_TIMEOUT_MS
  );
});
