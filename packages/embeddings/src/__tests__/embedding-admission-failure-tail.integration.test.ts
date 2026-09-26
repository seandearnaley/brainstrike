import { JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index.js';
import type { EmbeddingService } from '../types.js';
import type { EmbeddingAdmissionBudget } from '../worker/embedding-admission-budget.js';

const admissionProbe = vi.hoisted(
  (): {
    budget: EmbeddingAdmissionBudget | undefined;
    failRelease: (() => void) | undefined;
  } => ({ budget: undefined, failRelease: undefined })
);

vi.mock('../worker/embedding-admission-budget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker/embedding-admission-budget.js')>();
  return {
    ...actual,
    createEmbeddingAdmissionBudget: async (capacity: number): Promise<EmbeddingAdmissionBudget> => {
      const budget = await actual.createEmbeddingAdmissionBudget(capacity);
      admissionProbe.budget = budget;
      return {
        ...budget,
        release: async (count: number): Promise<void> => {
          if (count > 0 && admissionProbe.failRelease) {
            const fail = admissionProbe.failRelease;
            admissionProbe.failRelease = undefined;
            fail();
            throw new Error('injected first permit release failure');
          }
          await budget.release(count);
        },
      };
    },
  };
});

let db: PGlite;
beforeEach(async (): Promise<void> => {
  db = await wasmLoader.createPGlite('memory://embedding-admission-failure-tail');
  await migrate(db);
});
afterEach(async (): Promise<void> => {
  admissionProbe.budget = undefined;
  admissionProbe.failRelease = undefined;
  await db.close();
});

it('joins every pending failure write before releasing the batch after one release fails', async (): Promise<void> => {
  const now = new Date(Date.now() - 60_000).toISOString();
  for (const id of ['invalid-a', 'invalid-b']) {
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ($1, 'embeddings', 'embed_chunk', '{}', 'queued', $2, 0, 1, 0, $2, $2)`,
      [id, now]
    );
  }
  const secondWriteRelease = Promise.withResolvers<void>();
  const firstReleaseFailed = Promise.withResolvers<void>();
  const originalFail = JobQueue.prototype.fail;
  let failCalls = 0;
  const failSpy = vi.spyOn(JobQueue.prototype, 'fail').mockImplementation(async function (
    this: JobQueue,
    ...args
  ) {
    failCalls += 1;
    if (failCalls === 2) {
      await secondWriteRelease.promise;
    }
    return originalFail.apply(this, args);
  });
  admissionProbe.failRelease = (): void => firstReleaseFailed.resolve();
  const idleService: EmbeddingService = {
    calculateSimilarity: (): { similarity: number; distance: number; method: 'cosine' } => ({
      distance: 0,
      method: 'cosine',
      similarity: 1,
    }),
    dispose: async (): Promise<void> => {},
    generateDocEmbedding: async () => {
      throw new Error('No inference expected');
    },
    generateEmbedding: async () => {
      throw new Error('No inference expected');
    },
    generateEmbeddings: async () => {
      throw new Error('No inference expected');
    },
    generateQueryEmbedding: async () => {
      throw new Error('No inference expected');
    },
    getConfig: () => ({ modelId: 'jinaai/jina-embeddings-v2-base-code' }),
    getStatus: () => 'ready',
    initialize: async (): Promise<void> => {},
  };
  const controller = await startEmbeddingWorker({
    claimBatchSize: 2,
    concurrency: 1,
    db,
    idlePollInitialMs: 1000,
    leaseMs: 5000,
    maxInFlightJobs: 2,
    modelKey: 'jinaai/jina-embeddings-v2-base-code',
    service: idleService,
  });
  try {
    await firstReleaseFailed.promise;
    // Exceed the worker's 1000 ms error backoff so an early Promise.all
    // rejection reaches batch finally before the second write is acknowledged.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(failCalls).toBe(2);
    expect(await admissionProbe.budget?.inFlight()).toBe(2);
    secondWriteRelease.resolve();
    // Allow the worker's 1000 ms error backoff plus scheduling margin after
    // the second write settles; fixed poll counts can expire early on CI.
    const releaseDeadline = Date.now() + 5000;
    while (Date.now() < releaseDeadline) {
      if ((await admissionProbe.budget?.inFlight()) === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await admissionProbe.budget?.inFlight()).toBe(0);
  } finally {
    secondWriteRelease.resolve();
    await controller.stop();
    failSpy.mockRestore();
  }
});
