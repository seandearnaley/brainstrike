import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import type { IDatabase } from '../src/repositories/interfaces.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('JobQueue transactional enqueue', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-tx');
    await migrate(db);
  });

  it('rolls back enqueue when transaction fails', async () => {
    await expect(
      db.transaction(async (tx: PGlite) => {
        const jq = new JobQueue(tx as IDatabase);
        await jq.enqueue({ queue: 'embeddings', jobType: 'embed_chunk', payload: { n: 1 } });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const rows = await db.query('SELECT COUNT(*)::text as count FROM job_queue');
    const firstRow = rows.rows[0] as { count: string } | undefined;
    expect(Number(firstRow?.count ?? 0)).toBe(0);
  });
});
