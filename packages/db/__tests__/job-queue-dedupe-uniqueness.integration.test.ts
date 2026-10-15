/**
 * BST-991: the job-queue dedupe-uniqueness invariant, asserted as BEHAVIOUR.
 *
 * `JobQueue.enqueue`'s idempotent CTE is `INSERT … WHERE NOT EXISTS`, not
 * `ON CONFLICT` -- the UNIQUE partial index `idx_job_queue_dedupe_active` is the
 * only hard uniqueness backstop behind it. This pins that a second ACTIVE row
 * with the same dedupe_key is rejected by the DATABASE, not merely avoided by
 * the query. Raw INSERTs on purpose: they model the writers that bypass
 * `enqueue` (e.g. the app-shell debug benchmark) and prove the guarantee lives
 * in the schema.
 *
 * Was `job-queue-index-parity.integration.test.ts`, which ran the same
 * assertion twice -- once per migration runner -- because the Drizzle
 * (production) path and the numbered path had historically built DIFFERENT
 * indexes here: the unique partial index existed only on the numbered side
 * until migration 078 closed the gap. After the collapse to one current-schema
 * DDL (ADR-0020) there is a single construction path, so "parity between the
 * runners" is no longer a property that can hold or fail, and the duplicate
 * case is gone.
 *
 * Also dropped with the chain: "migration 078 cancels older duplicate actives
 * so the index can build". That was a cleanup pre-step for databases that had
 * ALREADY accumulated duplicate active rows before the unique index existed. A
 * greenfield install has no such rows, and ADR-0020 does not build conversion
 * of pre-existing data.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { TEST_ENGINE_EXTENSIONS } from './helpers/migrated-test-db.js';

describe('job_queue active-dedupe uniqueness', () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  function insertActiveJob(
    target: PGlite,
    id: string,
    state: 'queued' | 'running'
  ): Promise<unknown> {
    return target.query(
      `INSERT INTO job_queue (id, queue, job_type, state, dedupe_key)
       VALUES ($1, 'embeddings', 'embed_chunk', $2, 'dupe-key')`,
      [id, state]
    );
  }

  it('is enforced by the database and released once the job is terminal', async () => {
    // Boots from an empty cluster for real: the subject is what the shipped
    // schema construction guarantees.
    db = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
    await migrate(db);

    await insertActiveJob(db, 'job-a', 'queued');
    // The database itself must reject a second ACTIVE row for the key.
    await expect(insertActiveJob(db, 'job-b', 'running')).rejects.toThrow(
      /idx_job_queue_dedupe_active/u
    );

    // The index is PARTIAL on purpose: once the first job is terminal, the same
    // dedupe_key must be enqueueable again.
    await db.query(`UPDATE job_queue SET state = 'succeeded' WHERE id = 'job-a'`);
    await insertActiveJob(db, 'job-c', 'queued');

    const active = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM job_queue
       WHERE dedupe_key = 'dupe-key' AND state IN ('queued','running')`
    );
    expect(active.rows[0]?.n).toBe(1);
  }, 60_000);
});
