import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_tool_call_telemetry';
const OCCURRED_AT_INDEX = 'brainstrike_tool_call_telemetry_occurred_at_idx';

async function listIndexes(db: PGlite): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1',
    [TABLE]
  );
  return result.rows.map((row) => row.indexname);
}

describe('migration 085: tool-call telemetry occurred_at index (BST-1198)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(84);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => db.close());

  it('adds a dedicated occurred_at-leading index alongside the migration-083 shape', async () => {
    const migration = migrations.find((candidate) => candidate.version === 85);
    expect(migration).toBeDefined();
    await runner.runMigration(migration!);

    await db.query(
      `INSERT INTO ${TABLE}
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES ('id-1', 'thread-1', 'run-1', 'grepSearch', NOW(), 42, true, true, false)`
    );
    const rows = await db.query(`SELECT * FROM ${TABLE}`);
    expect(rows.rows).toHaveLength(1);
    expect(await listIndexes(db)).toContain(OCCURRED_AT_INDEX);
  });

  it('can serve a bare occurred_at range predicate as an index scan (planner-forced probe)', async () => {
    // A tiny in-test table is cheaper to seq-scan regardless of which indexes
    // exist, so cost-based EXPLAIN alone can't prove an index is usable here.
    // Forcing enable_seqscan off isolates the real question the review
    // thread raised: CAN the planner serve `occurred_at < $1` (no tool_id
    // predicate) via an index at all? With only the migration-083 composite
    // (tool_id, occurred_at DESC) index, the answer is no — Postgres/PGlite
    // cannot use a tool_id-leading index for a tool_id-less predicate, so
    // forcing seqscan off would still force a sequential scan. With the
    // migration-085 index added, it must resolve to an index scan on it.
    const migration = migrations.find((candidate) => candidate.version === 85)!;
    await runner.runMigration(migration);
    await db.query(`ANALYZE ${TABLE}`);
    await db.query('SET enable_seqscan = off');

    const plan = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM ${TABLE} WHERE occurred_at < '2026-01-01T00:00:00Z'::timestamptz`
    );
    const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(planText).toContain(OCCURRED_AT_INDEX);
    expect(planText).not.toMatch(/Seq Scan/i);
  });
});

describe('migration 085 in the drizzle runner', () => {
  let db: PGlite;
  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });
  afterEach(async () => db.close());

  it('creates the same occurred_at index in the production runner', {
    timeout: 60_000,
  }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    expect(await listIndexes(db)).toContain(OCCURRED_AT_INDEX);
  });
});
