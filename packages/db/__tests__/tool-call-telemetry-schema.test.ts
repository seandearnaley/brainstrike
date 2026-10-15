import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getResetTables } from '../src/reset-table-registry.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_tool_call_telemetry';

/**
 * Runtime behaviour of the tool-call telemetry table (BST-1190).
 *
 * Was migration-083's suite, plus migration-085's occurred_at index probe.
 * Dropped: the index-exists assertions and the separate "creates the same table
 * in the production runner" suite -- there is now ONE runner, and the catalog
 * readback in __tests__/fixtures/schema-catalog.snapshot.txt pins every index on
 * every table at once (ADR-0020).
 *
 * Kept: that the row round-trips, that the negative-count CHECK fires, that the
 * occurred_at-leading index can actually serve a bare range predicate as an
 * index scan, and that the table is registered for Clear/Factory Reset.
 */
describe('tool call telemetry', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores a narrow FK-less telemetry row', async () => {
    await db.query(
      `INSERT INTO ${TABLE}
        (id, thread_id, run_id, tool_id, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES ('id-1', 'thread-1', 'run-1', 'grepSearch', 42, true, true, false)`
    );

    const rows = await db.query(`SELECT * FROM ${TABLE}`);
    expect(rows.rows).toHaveLength(1);
  });

  it('rejects negative model-facing character counts', async () => {
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (id, thread_id, run_id, tool_id, model_facing_chars)
         VALUES ('id-bad', 'thread-1', 'run-1', 'grepSearch', -1)`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('can serve a bare occurred_at range predicate as an index scan (planner-forced probe)', async () => {
    // A tiny table is cheaper to seq-scan regardless of which indexes exist, so
    // cost-based EXPLAIN alone cannot prove an index is usable here. Forcing
    // enable_seqscan off isolates the real question migration-085 was added
    // for: CAN the planner serve `occurred_at < $1`, with no tool_id predicate,
    // via an index at all, or must it fall back to a full scan?
    //
    // This asserts the index-SCAN, not which index. Both candidates --
    // the dedicated `occurred_at` index and the `(tool_id, occurred_at DESC)`
    // composite, which this engine can skip-scan -- cost exactly the same here,
    // and the planner breaks that tie by index OID, i.e. by CREATION ORDER. The
    // chain created them in migration order (083 then 085); the single DDL emits
    // indexes alphabetically, so the OIDs differ and the tie breaks the other
    // way. The schema is identical either way (proved by the catalog fixture in
    // __tests__/fixtures/schema-catalog.snapshot.txt), so naming one index here
    // would pin an artefact of creation sequence rather than the behaviour.
    await db.query(`ANALYZE ${TABLE}`);
    await db.query('SET enable_seqscan = off');

    const plan = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM ${TABLE} WHERE occurred_at < '2026-01-01T00:00:00Z'::timestamptz`
    );
    const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(planText).not.toMatch(/Seq Scan/i);
    expect(planText).toMatch(/Index Scan using brainstrike_tool_call_telemetry_\w+/);
    // The chosen index must actually resolve the predicate as an index
    // condition; a scan that only FILTERS on occurred_at is the fallback this
    // probe exists to catch.
    expect(planText).toMatch(/Index Cond: \(occurred_at </);
  });

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});
