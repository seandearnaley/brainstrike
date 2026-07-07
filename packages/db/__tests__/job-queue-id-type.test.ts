import { describe, expect, it, vi } from 'vitest';
import type { IDatabase } from '../src';
import { JobQueue, type JobRow } from '../src/queue/job-queue';

function createJobRow(): JobRow {
  const now = new Date(0).toISOString();
  return {
    attempts: 0,
    backoff_ms: 0,
    created_at: now,
    dedupe_key: null,
    error: null,
    id: 'job-1',
    job_type: 'embed_chunk',
    lease_token: 'lease-1',
    leased_until: null,
    max_attempts: 5,
    payload: { chunkId: 'chunk-1' },
    queue: 'embeddings',
    run_at: now,
    state: 'succeeded',
    updated_at: now,
    worker_id: 'worker-1',
  };
}

describe('JobQueue id type resolution', () => {
  it('uses pg_catalog when information_schema is unavailable', async () => {
    const queries: string[] = [];
    const db: IDatabase = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('information_schema.columns')) {
          throw new Error('information_schema unavailable');
        }
        if (sql.includes('pg_catalog.pg_attribute')) {
          return { rows: [{ data_type: 'text' }] };
        }
        if (sql.includes('UPDATE job_queue AS j')) {
          return { rows: [createJobRow()] };
        }
        return { rows: [] };
      }),
    } as unknown as IDatabase;

    const queue = new JobQueue(db);
    const completed = await queue.completeBatch([{ id: 'job-1', leaseToken: 'lease-1' }]);

    expect(queries.some((sql) => sql.includes('pg_catalog.pg_attribute'))).toBe(true);
    expect(completed).toHaveLength(1);
  });
});
