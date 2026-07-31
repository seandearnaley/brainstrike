/**
 * BST-991: the dedupe-uniqueness invariant must hold on BOTH migration
 * runners.
 *
 * `JobQueue.enqueue`'s idempotent CTE is `INSERT … WHERE NOT EXISTS`, not
 * `ON CONFLICT` — the UNIQUE partial index `idx_job_queue_dedupe_active`
 * (numbered migration 007) is the only hard uniqueness backstop behind it.
 * The Drizzle runner (the PRODUCTION path) never created it: verified by
 * diffing `pg_indexes` across fully migrated instances of both runners, the
 * Drizzle side had only the plain non-unique `idx_job_queue_dedupe_key`.
 * Migration 078 closes the gap (with a duplicate-cleanup pre-step so the
 * unique index can build on databases that already accumulated duplicates).
 *
 * These tests pin the BEHAVIOR — a second active row with the same
 * dedupe_key must be rejected by the database itself, not merely avoided by
 * the CTE — on both runners, so the invariant cannot silently regress on
 * either path. Raw INSERTs on purpose: they model the writers that bypass
 * `enqueue` (e.g. the app-shell debug benchmark) and prove the guarantee
 * lives in the schema, not the query.
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';

describe('job_queue dedupe uniqueness across migration runners', () => {
  const open: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(open.map((db) => db.close()));
    open.length = 0;
  });

  function freshPGlite(): PGlite {
    const db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
    open.push(db);
    return db;
  }

  async function drizzleMigratedDb(): Promise<PGlite> {
    const db = freshPGlite();
    const result = await runMigrations(db);
    expect(result.success).toBe(true);
    return db;
  }

  async function numberedMigratedDb(): Promise<PGlite> {
    const db = freshPGlite();
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    return db;
  }

  function insertActiveJob(db: PGlite, id: string, state: 'queued' | 'running'): Promise<unknown> {
    return db.query(
      `INSERT INTO job_queue (id, queue, job_type, state, dedupe_key)
       VALUES ($1, 'embeddings', 'embed_chunk', $2, 'dupe-key')`,
      [id, state]
    );
  }

  async function assertActiveDedupeEnforced(db: PGlite): Promise<void> {
    await insertActiveJob(db, 'job-a', 'queued');
    // The database itself must reject a second ACTIVE row for the key.
    await expect(insertActiveJob(db, 'job-b', 'running')).rejects.toThrow(
      /idx_job_queue_dedupe_active/u
    );
    // The index is PARTIAL on purpose: once the first job is terminal, the
    // same dedupe_key must be enqueueable again.
    await db.query(`UPDATE job_queue SET state = 'succeeded' WHERE id = 'job-a'`);
    await insertActiveJob(db, 'job-c', 'queued');
    const active = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM job_queue WHERE dedupe_key = 'dupe-key' AND state IN ('queued','running')`
    );
    expect(active.rows[0]?.n).toBe(1);
  }

  it('the numbered runner enforces active-dedupe uniqueness (007)', async () => {
    await assertActiveDedupeEnforced(await numberedMigratedDb());
  });

  it('the Drizzle runner enforces active-dedupe uniqueness (078)', async () => {
    await assertActiveDedupeEnforced(await drizzleMigratedDb());
  });

  it('migration 078 cancels older duplicate actives so the index can build', async () => {
    // A database that accumulated duplicates BEFORE 078 must migrate cleanly:
    // replay the Drizzle chain up to 077 by running the full chain on a fresh
    // instance is not possible piecemeal here, so model the pre-078 state
    // directly — drop the index, insert duplicates, re-run the migration SQL.
    const db = await drizzleMigratedDb();
    await db.query('DROP INDEX idx_job_queue_dedupe_active');
    await insertActiveJob(db, 'old-dupe', 'running');
    await db.query(
      `UPDATE job_queue
          SET created_at = '2020-01-01T00:00:00Z',
              lease_token = 'stale-lease',
              leased_until = '2020-01-01T00:01:00Z'
        WHERE id = 'old-dupe'`
    );
    await insertActiveJob(db, 'new-dupe', 'running');

    const { migration078JobQueueDedupeActiveIndex } = await import(
      '../src/migrations/078-job-queue-dedupe-active-index.js'
    );
    const upSql = migration078JobQueueDedupeActiveIndex.up;
    if (typeof upSql !== 'string') {
      throw new Error('Expected migration 078 up to be SQL text, not a callback.');
    }
    for (const statement of upSql.split('--> statement-breakpoint')) {
      await db.exec(statement);
    }

    const rows = await db.query<{
      error: string | null;
      id: string;
      leased_until: string | null;
      state: string;
      updated_at: string;
    }>(
      `SELECT id, state, error, leased_until, updated_at
         FROM job_queue WHERE dedupe_key = 'dupe-key' ORDER BY id`
    );
    expect(rows.rows).toMatchObject([
      { error: null, id: 'new-dupe', state: 'running' },
      {
        // The error annotation IS the forensics that justifies cancel-over-
        // delete; the lease shape matches JobQueue.cancel (leased_until
        // nulled).
        error: 'canceled by migration 078: duplicate active dedupe_key',
        id: 'old-dupe',
        leased_until: null,
        state: 'canceled',
      },
    ]);
    // updated_at is a TEXT column compared lexicographically everywhere
    // (prune, ORDER BY): the migration must write the contractual ISO shape,
    // not CURRENT_TIMESTAMP's space-separated rendering.
    expect(rows.rows[1]?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    // canceled_total is a monotonic lifetime counter (064): the migration's
    // cancellations must be counted before pruning deletes the rows.
    const metrics = await db.query<{ canceled_total: string | number }>(
      `SELECT canceled_total FROM job_queue_metrics WHERE queue = 'embeddings'`
    );
    expect(Number(metrics.rows[0]?.canceled_total)).toBe(1);
    // And the index now exists and enforces.
    await expect(insertActiveJob(db, 'post-078', 'queued')).rejects.toThrow(
      /idx_job_queue_dedupe_active/u
    );
  });
});
