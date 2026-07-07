import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import type { IDatabase } from '../src/repositories/interfaces.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('JobQueue expired lease claiming', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-expired');
    await migrate(db);
  });

  it('claims expired running jobs and bumps attempts on claim', async () => {
    const jq = new JobQueue(db as IDatabase);
    await jq.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'embeddings' });
    const c1 = await jq.claim({ leaseMs: 50, queue: 'embeddings' });
    expect(c1).not.toBeNull();
    const id = c1?.id as string;
    const token = c1?.lease_token as string;

    // Force lease to be expired by setting leased_until in the past
    await db.query('UPDATE job_queue SET leased_until = $1 WHERE id = $2', [
      new Date(Date.now() - 10_000).toISOString(),
      id,
    ]);

    const c2 = await jq.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(c2).not.toBeNull();
    expect(c2?.id).toBe(id);
    // attempts should have incremented on both claims
    expect((c2?.attempts as number) >= 2).toBe(true);

    // complete via the new lease token
    const done = await jq.complete({ id, leaseToken: (c2?.lease_token as string) || token });
    expect(done?.state).toBe('succeeded');
  });
});
