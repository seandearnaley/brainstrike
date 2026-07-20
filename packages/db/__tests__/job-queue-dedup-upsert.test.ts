import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/queue/job-queue.js';
import type { IDatabase } from '../src/repositories/interfaces.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('JobQueue dedupe upsert semantics', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  it('keeps earliest run_at and returns the existing job on conflict', async () => {
    const jq = new JobQueue(db as IDatabase);
    const now = new Date();
    const later = new Date(now.getTime() + 60_000).toISOString();
    const earlier = new Date(now.getTime() - 60_000).toISOString();

    const first = await jq.enqueue({
      dedupeKey: 'D:1',
      jobType: 'embed_chunk',
      payload: { n: 1 },
      queue: 'embeddings',
      runAt: later,
    });
    const second = await jq.enqueue({
      dedupeKey: 'D:1',
      jobType: 'embed_chunk',
      payload: { n: 2 },
      queue: 'embeddings',
      runAt: earlier,
    });

    expect(second.id).toBe(first.id);
    // Should keep the earliest schedule (earlier)
    const row = await db.query('SELECT run_at FROM job_queue WHERE id = $1', [first.id]);
    const firstRow = row.rows[0] as { run_at: string } | undefined;
    expect(firstRow?.run_at).toBe(earlier);
  });
});
