import type { IDatabase } from '@brainstrike/db';
import { JobQueue } from '@brainstrike/db';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startEmbeddingWorker } from '../index.js';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types.js';

const modelId = 'jinaai/jina-embeddings-v2-base-code';
const modelKey = `local::${modelId}`;
const inputHash = '0000000000000000000000000000000000000000000000000000000000000001';

class ReadyEmbeddingService implements EmbeddingService {
  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    return Promise.resolve();
  }
  generateEmbedding(_text: string): Promise<EmbeddingResult> {
    throw new Error('Up-to-date chunks should not be embedded again.');
  }
  generateEmbeddings(_texts: string[]): Promise<EmbeddingResult[]> {
    throw new Error('Up-to-date chunks should not be embedded again.');
  }
  generateEmbeddingsStream(
    _texts: string[],
    _onBatch: (batch: {
      startIndex: number;
      endIndex: number;
      results: EmbeddingResult[];
    }) => Promise<void> | void
  ): Promise<void> {
    throw new Error('Up-to-date chunks should not be embedded again.');
  }
  generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  calculateSimilarity(_a: number[], _b: number[]): SimilarityResult {
    return { distance: 0, method: 'cosine', similarity: 1 };
  }
  getStatus(): EmbeddingStatus {
    return 'ready';
  }
  getConfig(): EmbeddingConfig {
    return { modelId };
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for embedding worker.');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('already embedded job completion ownership', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('counts only jobs whose existing embedding completion kept its lease', async () => {
    const now = new Date().toISOString();
    const setId = 'set-already-embedded';
    const jobIds = ['job-valid', 'job-lost'];
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, 768, 'cosine', $4)`,
      [setId, modelKey, modelId, now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ('file-already-embedded', 'embedded.ts', '/embedded.ts', 10, 'content', 'file-hash', 10, $1, $1)`,
      [now]
    );
    for (const [index, jobId] of jobIds.entries()) {
      const chunkId = `chunk-${jobId}`;
      const sourceHash = `source-${jobId}`;
      await db.query(
        `INSERT INTO file_chunks
          (id, file_record_id, chunk_index, content, content_hash, token_count,
           chunk_type, chunk_size, embedding_hash, embedding_set_id, created_at, updated_at)
         VALUES ($1, 'file-already-embedded', $2, 'content', $3, 10,
           'text', 10, $4, $5, $6, $6)`,
        [chunkId, index, sourceHash, inputHash, setId, now]
      );
      await db.query(
        `INSERT INTO job_queue
          (id, queue, job_type, payload, state, run_at, attempts, max_attempts,
           backoff_ms, created_at, updated_at)
         VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [
          jobId,
          JSON.stringify({
            chunkId,
            embeddingInputHash: inputHash,
            embeddingSetId: setId,
            expectedDimension: 768,
            modelKey,
            sourceContentHash: sourceHash,
          }),
          now,
        ]
      );
    }

    const originalQuery = db.query.bind(db);
    let leaseChangedBeforeCompletion = false;
    (db as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
      ...args: unknown[]
    ) => {
      const sql = args[0];
      // Intercept JobQueue.completeBatch after claim but before its token-guarded UPDATE.
      if (
        !leaseChangedBeforeCompletion &&
        typeof sql === 'string' &&
        sql.includes('WITH completed AS') &&
        sql.includes('FROM unnest(')
      ) {
        leaseChangedBeforeCompletion = true;
        await originalQuery(
          `UPDATE job_queue SET lease_token = 'replacement-owner' WHERE id = $1`,
          ['job-lost']
        );
      }
      return originalQuery(...(args as [string, unknown[]?]));
    };

    const metricLogs: Record<string, unknown>[] = [];
    const controller = await startEmbeddingWorker({
      claimBatchSize: 2,
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 60_000,
      log: (event, meta) => {
        if (event === 'worker_metrics') {
          metricLogs.push(meta as Record<string, unknown>);
        }
      },
      metricsIntervalMs: 5000,
      modelKey: modelId,
      service: new ReadyEmbeddingService(),
    });
    try {
      await waitFor(async () => {
        const result = await db.query<{ id: string; state: string }>(
          'SELECT id, state FROM job_queue WHERE id = ANY($1::text[]) ORDER BY id',
          [jobIds]
        );
        return (
          leaseChangedBeforeCompletion &&
          result.rows.some((row) => row.id === 'job-valid' && row.state === 'succeeded')
        );
      });
      await waitFor(async () => metricLogs.length > 0);

      // Both slots must be available again after the first batch. One leaked
      // stale slot would force separate claims and distinct lease tokens.
      await db.query(
        `INSERT INTO job_queue
          (id, queue, job_type, payload, state, run_at, attempts, max_attempts,
           backoff_ms, created_at, updated_at)
         SELECT CASE id WHEN 'job-valid' THEN 'job-followup-valid' ELSE 'job-followup-lost' END,
           queue, job_type, payload, 'queued', $1, 0, max_attempts, 0, $1, $1
         FROM job_queue WHERE id = ANY($2::text[])`,
        [new Date().toISOString(), jobIds]
      );
      await waitFor(async () => {
        const result = await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM job_queue
           WHERE id IN ('job-followup-valid', 'job-followup-lost') AND state = 'succeeded'`
        );
        return result.rows[0]?.count === 2;
      });
      const followups = await db.query<{ lease_token: string }>(
        `SELECT lease_token FROM job_queue
         WHERE id IN ('job-followup-valid', 'job-followup-lost') ORDER BY id`
      );
      expect(followups.rows).toHaveLength(2);
      expect(followups.rows[0]?.lease_token).toBeTruthy();
      expect(followups.rows[0]?.lease_token).toBe(followups.rows[1]?.lease_token);
    } finally {
      await controller.stop();
    }

    expect(metricLogs[0]?.['processed']).toBe(1);
    const jobs = await db.query<{ id: string; state: string }>(
      'SELECT id, state FROM job_queue WHERE id = ANY($1::text[]) ORDER BY id',
      [jobIds]
    );
    expect(jobs.rows).toEqual([
      { id: 'job-lost', state: 'running' },
      { id: 'job-valid', state: 'succeeded' },
    ]);
  });

  it('does not count failure after another worker reclaims the lease', async () => {
    const now = new Date().toISOString();
    const jobId = 'job-reclaimed-before-failure';
    const setId = 'set-failure-ownership';
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, 768, 'cosine', $4)`,
      [setId, modelKey, modelId, now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ('file-failure-ownership', 'failure.ts', '/failure.ts', 10, 'content', 'file-hash', 10, $1, $1)`,
      [now]
    );
    await db.query(
      `INSERT INTO file_chunks
        (id, file_record_id, chunk_index, content, content_hash, token_count,
         chunk_type, chunk_size, created_at, updated_at)
       VALUES ('chunk-failure-ownership', 'file-failure-ownership', 0, 'content',
         'source-hash', 10, 'text', 10, $1, $1)`,
      [now]
    );
    await db.query(
      `INSERT INTO job_queue
        (id, queue, job_type, payload, state, run_at, attempts, max_attempts,
         backoff_ms, created_at, updated_at)
       VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
      [
        jobId,
        JSON.stringify({
          chunkId: 'chunk-failure-ownership',
          embeddingInputHash: inputHash,
          embeddingSetId: setId,
          expectedDimension: 768,
          modelKey,
          sourceContentHash: 'source-hash',
        }),
        now,
      ]
    );

    let reclaimedToken: string | null = null;
    class ReclaimedThenFailingService extends ReadyEmbeddingService {
      override async generateEmbeddingsStream(): Promise<void> {
        await db.query('UPDATE job_queue SET leased_until = $1 WHERE id = $2', [
          new Date(Date.now() - 1000).toISOString(),
          jobId,
        ]);
        const reclaimed = await new JobQueue(db as unknown as IDatabase).claim({
          leaseMs: 60_000,
          queue: 'embeddings',
          workerId: 'replacement-worker',
        });
        reclaimedToken = reclaimed?.lease_token ?? null;
        throw new Error('invalid input: controlled embedding failure');
      }
    }

    const metricLogs: Record<string, unknown>[] = [];
    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      concurrency: 1,
      db: db as unknown as IDatabase,
      leaseMs: 60_000,
      log: (event, meta) => {
        if (event === 'worker_metrics') {
          metricLogs.push(meta as Record<string, unknown>);
        }
      },
      metricsIntervalMs: 5000,
      modelKey: modelId,
      service: new ReclaimedThenFailingService(),
    });
    try {
      await waitFor(async () => reclaimedToken !== null);
      await waitFor(async () => metricLogs.length > 0);
    } finally {
      await controller.stop();
    }

    const job = await db.query<{ lease_token: string; state: string }>(
      'SELECT lease_token, state FROM job_queue WHERE id = $1',
      [jobId]
    );
    expect(job.rows[0]).toEqual({ lease_token: reclaimedToken, state: 'running' });
    expect(metricLogs[0]?.['failed']).toBe(0);
  });
});
