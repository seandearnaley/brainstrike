import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the job-queue outcome counters.
 *
 * Was migration-064's suite. Dropped: "adds failed_total and canceled_total
 * columns", pinned by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt; "rollback drops the outcome
 * columns", because ADR-0020 does not build rollback; and "backfills lifetime
 * counters from pre-existing terminal rows", which has no subject -- a
 * greenfield install has no terminal job rows predating the counters.
 *
 * Kept: that the counters default to zero and that the ON CONFLICT increment is
 * additive rather than overwriting, which is what the prune path depends on.
 */
describe('job queue outcome metrics', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('defaults new counters to zero and supports atomic increments', async () => {
    await db.query("INSERT INTO job_queue_metrics (queue) VALUES ('embeddings')");

    const defaults = await db.query<{
      canceled_total: number | string;
      failed_total: number | string;
    }>("SELECT failed_total, canceled_total FROM job_queue_metrics WHERE queue = 'embeddings'");
    expect(Number(defaults.rows[0]?.failed_total ?? -1)).toBe(0);
    expect(Number(defaults.rows[0]?.canceled_total ?? -1)).toBe(0);

    await db.query(
      `INSERT INTO job_queue_metrics (queue, failed_total, canceled_total)
       VALUES ('embeddings', 2, 3)
       ON CONFLICT (queue) DO UPDATE
         SET failed_total = job_queue_metrics.failed_total + EXCLUDED.failed_total,
             canceled_total = job_queue_metrics.canceled_total + EXCLUDED.canceled_total`
    );

    const incremented = await db.query<{
      canceled_total: number | string;
      failed_total: number | string;
    }>("SELECT failed_total, canceled_total FROM job_queue_metrics WHERE queue = 'embeddings'");
    expect(Number(incremented.rows[0]?.failed_total ?? -1)).toBe(2);
    expect(Number(incremented.rows[0]?.canceled_total ?? -1)).toBe(3);
  });
});
