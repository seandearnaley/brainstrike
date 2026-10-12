import type { ClaimedJob, IDatabase, Job } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingService } from '../types.js';
import { startEmbeddingWorker } from '../worker/embedding-worker.js';

const queue = vi.hoisted(() => ({
  claimMany: vi.fn<() => Promise<ClaimedJob[]>>(),
  completeBatch: vi.fn<() => Promise<Job[]>>(),
  flush: vi.fn<() => Promise<void>>(),
}));

vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db')>()),
  JobQueue: class {
    claimMany = queue.claimMany;
    completeBatch = queue.completeBatch;
  },
}));

vi.mock('../worker/embedding-provider-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worker/embedding-provider-runtime.js')>()),
  ensureLocalRuntime: vi.fn(),
}));

vi.mock('../worker/embedding-worker-db-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worker/embedding-worker-db-io.js')>()),
  resolveIdType: vi.fn().mockResolvedValue('text'),
}));

vi.mock('../worker/embedding-worker-chunk-filter.js', () => ({
  loadAndFilterChunks: async (jobs: ClaimedJob[]) => ({
    completed: jobs.map((job) => ({ job })),
    orphanCount: 0,
    staleCount: 0,
    toProcess: [],
  }),
}));

vi.mock('../worker/embedding-stats-refresh-controller.js', () => ({
  createEmbeddingStatsRefreshController: () => ({ flush: queue.flush }),
}));

const job: ClaimedJob = {
  attempts: 0,
  backoff_ms: 0,
  chunk_id: 'chunk-1',
  created_at: '2026-08-21T00:00:00.000Z',
  dedupe_key: 'chunk-1:set-1:content-hash',
  embedding_set_id: 'set-1',
  error: null,
  id: 'job-1',
  jobType: 'embed_chunk',
  lease_token: 'lease-1',
  leasedUntil: '2026-08-21T00:01:00.000Z',
  max_attempts: 3,
  payload: {
    chunkId: 'chunk-1',
    embeddingInputHash: 'a80aabf0d21d49164154d0972531edf40605eb595aff029c37bc74ca083a98df',
    embeddingSetId: 'set-1',
    expectedDimension: 768,
    modelKey: 'local::bge-m3',
    sourceContentHash: 'content-hash',
  },
  queue: 'embeddings',
  runAt: '2026-08-21T00:00:00.000Z',
  state: 'running',
  updated_at: '2026-08-21T00:00:00.000Z',
  worker_id: 'worker-1',
};

// Drain the worker's Promise/Effect boundaries without advancing a timer turn.
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
  }
}

function createService(): EmbeddingService {
  const unusedInference = async (): Promise<never> => {
    throw new Error('Already embedded jobs must not run inference');
  };
  return {
    calculateSimilarity: () => ({ distance: 0, method: 'cosine', similarity: 1 }),
    dispose: vi.fn().mockResolvedValue(undefined),
    generateDocEmbedding: unusedInference,
    generateEmbedding: unusedInference,
    generateEmbeddings: unusedInference,
    generateEmbeddingsStream: unusedInference,
    generateQueryEmbedding: unusedInference,
    getConfig: () => ({ modelId: 'bge-m3' }),
    getStatus: () => 'ready',
    initialize: unusedInference,
  };
}

describe('embedding worker task yielding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('EMBED_WORKER_ENABLED', 'true');
    queue.claimMany.mockReset();
    queue.completeBatch.mockReset();
    queue.flush.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function start(): Promise<{
    controller: Awaited<ReturnType<typeof startEmbeddingWorker>>;
    service: EmbeddingService;
  }> {
    const service = createService();
    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      db: { query: vi.fn() } as unknown as IDatabase,
      initializeLocalModelOnStart: false,
      maxInFlightJobs: 1,
      modelKey: 'local::bge-m3',
      service,
    });
    await drainMicrotasks();
    return { controller, service };
  }

  it('joins completion before yielding, then claims on the next task without advancing the clock', async () => {
    const completion = Promise.withResolvers<Job[]>();
    const nextClaim = Promise.withResolvers<ClaimedJob[]>();
    queue.claimMany.mockResolvedValueOnce([job]).mockReturnValue(nextClaim.promise);
    queue.completeBatch.mockReturnValue(completion.promise);
    const { controller, service } = await start();
    try {
      expect(queue.completeBatch).toHaveBeenCalledWith([
        { id: job.id, leaseToken: job.lease_token },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(queue.claimMany).toHaveBeenCalledTimes(1);

      completion.resolve([job]);
      await drainMicrotasks();
      expect(queue.claimMany).toHaveBeenCalledTimes(1);
      const beforeYield = Date.now();
      await vi.advanceTimersByTimeAsync(0);
      expect(queue.claimMany).toHaveBeenCalledTimes(2);
      expect(Date.now()).toBe(beforeYield);
    } finally {
      completion.resolve([job]);
      nextClaim.resolve([]);
      await controller.stop();
    }
    expect(service.dispose).toHaveBeenCalledOnce();
  });

  it('cancels the pending task yield and joins the worker without another claim', async () => {
    queue.claimMany.mockResolvedValue([job]);
    queue.completeBatch.mockResolvedValue([job]);
    const { controller, service } = await start();
    try {
      expect(queue.completeBatch).toHaveBeenCalledOnce();
      expect(queue.claimMany).toHaveBeenCalledOnce();
    } finally {
      const stoppedAt = Date.now();
      await controller.stop();
      expect(Date.now()).toBe(stoppedAt);
    }
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(queue.flush).toHaveBeenCalledWith('worker-stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.claimMany).toHaveBeenCalledOnce();
  });
});
