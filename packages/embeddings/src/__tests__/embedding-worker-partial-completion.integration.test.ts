import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
  JobQueue,
  precreateEmptyDimensionIndex,
} from '@brainstrike/db';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import { buildEmbeddingInputHash } from '@brainstrike/indexing-contract';
import { expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index.js';
import type { EmbeddingService } from '../types.js';

it('settles each committed completion before a later statement fails and retries only unfinished jobs', async () => {
  const db = await createMigratedTestDb();
  await precreateEmptyDimensionIndex(db, 768);
  const modelKey = 'local::jinaai/jina-embeddings-v2-base-code';
  await db.query(
    `INSERT INTO embedding_sets(id,model_key,model_id,dimensions,distance,created_at)
    VALUES ('set', $1, 'jinaai/jina-embeddings-v2-base-code', 768, 'cosine', NOW())`,
    [modelKey]
  );
  await db.exec(`INSERT INTO file_records(id,name,path,size,embedding_set_id) VALUES('file','fixture','fixture',1,'set');
    INSERT INTO file_chunks(id,file_record_id,chunk_index,content,content_hash,embedding_set_id)
    SELECT 'chunk-' || n,'file',n,'content','hash','set' FROM generate_series(1,130)n;
    CREATE TABLE fixture_vector_writes(chunk_id text PRIMARY KEY, writes int NOT NULL);
    CREATE FUNCTION fixture_count_vector_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO fixture_vector_writes VALUES(NEW.id,1)
        ON CONFLICT(chunk_id) DO UPDATE SET writes=fixture_vector_writes.writes+1;
        RETURN NEW;
      END $$;
    CREATE TRIGGER fixture_vector_write AFTER UPDATE OF embedding ON file_chunks
    FOR EACH ROW WHEN(NEW.embedding IS NOT NULL) EXECUTE FUNCTION fixture_count_vector_write();`);
  const hash = await buildEmbeddingInputHash('hash', modelKey);
  await new JobQueue(db).enqueueBatch(
    Array.from({ length: 130 }, (_, i) => ({
      jobType: 'embed_chunk' as const,
      payload: {
        chunkId: `chunk-${i + 1}`,
        embeddingInputHash: hash,
        embeddingSetId: 'set',
        expectedDimension: 768,
        modelKey,
        sourceContentHash: 'hash',
      },
      queue: 'embeddings',
    }))
  );
  // Legacy duplicate jobs compete for every chunk; grouping cannot depend on SQL return order.
  // Both leases must stay in one atomic completion statement.
  await db.exec(`INSERT INTO job_queue(id,queue,job_type,payload,state,run_at,attempts,max_attempts,backoff_ms,created_at,updated_at)
    SELECT 'duplicate-' || id,queue,job_type,payload,'queued',run_at,0,3,0,created_at,updated_at
    FROM job_queue`);
  const scheduler = createDatabaseWorkScheduler({ foregroundQuietMs: 0 });
  let writeAttempt = 0;
  let foreground: Promise<unknown> | undefined;
  const order: string[] = [];
  const statements: number[] = [];
  const completionCounts: number[] = [];
  const tracked = createScheduledDbHandle(
    {
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        if (sql.includes('updated_chunks AS')) {
          writeAttempt += 1;
          const chunkIds = params?.[3];
          if (!Array.isArray(chunkIds)) {
            throw new Error('Missing completion chunk IDs');
          }
          statements.push(new Set(chunkIds).size);
          order.push('completion');
          // Foreground arrives while the first completion owns the engine turn.
          foreground ??= scheduler.run(
            () => {
              order.push('foreground');
              return db.query('SELECT 1');
            },
            { priority: 'foreground' }
          );
          if (writeAttempt === 2) {
            throw new Error('transient fixture completion failure');
          }
        }
        return db.query<T>(sql, params);
      },
    },
    scheduler,
    'background'
  );
  const failedInputs: number[] = [];
  const originalFail = JobQueue.prototype.failBatch;
  const failSpy = vi.spyOn(JobQueue.prototype, 'failBatch').mockImplementation(function (
    this: JobQueue,
    ...args
  ) {
    failedInputs.push(args[0].jobs.length);
    return originalFail.apply(this, args);
  });
  const result = {
    dimensions: 768,
    embedding: Array.from({ length: 768 }, () => 0.1),
    model: 'fake',
    usage: { totalTokens: 1 },
  };
  const service: EmbeddingService = {
    calculateSimilarity: () => ({ distance: 0, method: 'cosine', similarity: 1 }),
    dispose: async () => {},
    generateDocEmbedding: async () => result,
    generateEmbedding: async () => result,
    generateEmbeddings: async (texts) => texts.map(() => result),
    generateEmbeddingsStream: async (texts, onBatch) => {
      await onBatch({ endIndex: texts.length, results: texts.map(() => result), startIndex: 0 });
    },
    generateQueryEmbedding: async () => result,
    getConfig: () => ({ modelId: 'jinaai/jina-embeddings-v2-base-code' }),
    getStatus: () => 'ready',
    initialize: async () => {},
  };
  const controller = await startEmbeddingWorker({
    claimBatchSize: 260,
    concurrency: 1,
    db: tracked,
    leaseMs: 60_000,
    log: (event, meta) => {
      if (
        event === 'embedding_completion_batch' &&
        typeof meta === 'object' &&
        meta !== null &&
        'completedJobCount' in meta &&
        typeof meta.completedJobCount === 'number'
      ) {
        completionCounts.push(meta.completedJobCount);
      }
    },
    maxInFlightJobs: 260,
    modelKey,
    resolvePipelineCapacity: () => ({
      maxPendingCompletionBatches: 1,
      maxPendingCompletionBytes: 1_000_000,
      maxPendingCompletionChunks: 260,
      streamBatchSize: 260,
    }),
    service,
  });
  try {
    await vi.waitFor(
      async () => {
        const states = await db.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM job_queue WHERE state='succeeded'"
        );
        expect(states.rows[0]?.count).toBe(260);
      },
      { interval: 20, timeout: 15_000 }
    );
    await foreground;
    expect(failedInputs).toEqual([132]);
    expect(completionCounts.reduce((sum, count) => sum + count, 0)).toBe(260);
    expect(statements.every((size) => size <= 64)).toBe(true);
    expect(order.slice(0, 3)).toEqual(['completion', 'foreground', 'completion']);
    expect(
      (
        await db.query(
          'SELECT attempts,COUNT(*)::int AS count FROM job_queue GROUP BY attempts ORDER BY attempts'
        )
      ).rows
    ).toEqual([
      { attempts: 1, count: 128 },
      { attempts: 2, count: 132 },
    ]);
    expect(
      (
        await db.query(
          'SELECT COUNT(*)::int AS count, SUM(writes)::int AS writes, MAX(writes) AS max FROM fixture_vector_writes'
        )
      ).rows
    ).toEqual([{ count: 130, max: 1, writes: 130 }]);
    expect(
      (
        await db.query(
          'SELECT COUNT(*)::int AS count FROM file_chunks WHERE embedding IS NOT NULL AND embedding_hash=$1',
          [hash]
        )
      ).rows
    ).toEqual([{ count: 130 }]);
  } finally {
    await controller.stop();
    failSpy.mockRestore();
    await db.close();
  }
}, 30_000);
