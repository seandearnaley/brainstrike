import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the assistant run-outcomes table.
 *
 * Was migration-062's suite. Dropped: "creates the table and indexes", pinned
 * exhaustively by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt, and "rollback drops the
 * table", because ADR-0020 does not build rollback. Kept: the one-label-per-run
 * upsert and the two closed CHECK vocabularies.
 */
describe('assistant run outcomes', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('holds exactly one label per run with upsert semantics', async () => {
    await db.query(
      `INSERT INTO brainstrike_assistant_run_outcomes
        (run_id, thread_id, resource_id, verdict, source, detail, labeled_at)
       VALUES ('run-1', 'thread-1', 'workspace-a', 'succeeded', 'user', NULL, NOW())`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_run_outcomes
        (run_id, thread_id, resource_id, verdict, source, detail, labeled_at)
       VALUES ('run-1', 'thread-1', 'workspace-a', 'failed', 'edit_revert', 'all edits reverted', NOW())
       ON CONFLICT (run_id) DO UPDATE SET
        verdict = EXCLUDED.verdict,
        source = EXCLUDED.source,
        detail = EXCLUDED.detail,
        labeled_at = EXCLUDED.labeled_at,
        updated_at = NOW()`
    );

    const rows = await db.query<{ verdict: string; source: string; detail: string | null }>(
      `SELECT verdict, source, detail FROM brainstrike_assistant_run_outcomes WHERE run_id = 'run-1'`
    );
    expect(rows.rows).toEqual([
      { detail: 'all edits reverted', source: 'edit_revert', verdict: 'failed' },
    ]);
  });

  it('rejects unknown verdicts and sources via CHECK constraints', async () => {
    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_outcomes
          (run_id, thread_id, resource_id, verdict, source, labeled_at)
         VALUES ('run-bad', 'thread-1', 'workspace-a', 'sort-of-worked', 'user', NOW())`
      )
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_outcomes
          (run_id, thread_id, resource_id, verdict, source, labeled_at)
         VALUES ('run-bad', 'thread-1', 'workspace-a', 'succeeded', 'vibes', NOW())`
      )
    ).rejects.toThrow();
  });
});
