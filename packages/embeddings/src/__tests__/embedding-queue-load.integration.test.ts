import type { IDatabase } from '@brainstrike/db';
import { JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import { buildEmbeddingJobInputHashes } from '@brainstrike/indexing-contract';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index.js';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types.js';

const LOAD_TEST_TIMEOUT_MS = 90_000;
const LOAD_TEST_LEASE_MS = 1000;
const LOAD_TEST_HEARTBEAT_INTERVAL_MS = 250;
const SCENARIO_COMPLETION_TIMEOUT_MS = 15_000;
const FIRST_WAVE_RENDEZVOUS_TIMEOUT_MS = 5000;
const WORKER_LOOP_RENDEZVOUS_TIMEOUT_MS = 5000;
const JOB_COUNT = 12;
const MAX_IN_FLIGHT_JOBS = 4;
const EMBEDDING_DIMENSIONS = 8;
const MODEL_KEY = 'local::load-test-model';
const TEXT_ENCODER = new TextEncoder();

interface QueueLoadMetrics {
  readonly adaptiveClaimLimits: readonly number[];
  readonly claimedBatchSizes: readonly number[];
  readonly claimLimits: readonly number[];
  readonly completionLatencyMs: number;
  readonly concurrency: number;
  readonly firstWaveArrivalCount: number;
  readonly firstWaveRendezvousReached: boolean;
  readonly jobCount: number;
  readonly leaseClaimCount: number;
  readonly maxAttempts: number;
  readonly peakClaimedJobs: number;
  readonly peakInputBytesInFlight: number;
  readonly peakVectorsInFlight: number;
  readonly workerLoopArrivalCount: number;
  readonly workerLoopRendezvousReached: boolean;
}

class WorkerLoopRendezvous {
  private arrivalCount = 0;
  private readonly expectedArrivalCount: number;
  private readonly releasePromise: Promise<void>;
  private releasePromiseResolve = (): void => {};
  private released = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  reached = false;

  constructor(expectedArrivalCount: number) {
    if (!(Number.isInteger(expectedArrivalCount) && expectedArrivalCount > 0)) {
      throw new Error(
        `Load-test worker-loop rendezvous requires a positive integer, got ${expectedArrivalCount}.`
      );
    }
    this.expectedArrivalCount = expectedArrivalCount;
    this.releasePromise = new Promise<void>((resolve) => {
      this.releasePromiseResolve = resolve;
    });
  }

  get arrivals(): number {
    return this.arrivalCount;
  }

  dispose(): void {
    this.release();
  }

  async wait(): Promise<void> {
    if (this.released) {
      return;
    }
    if (!this.timeout) {
      this.timeout = setTimeout(() => {
        this.release();
      }, WORKER_LOOP_RENDEZVOUS_TIMEOUT_MS);
      this.timeout.unref();
    }
    this.arrivalCount += 1;
    if (this.arrivalCount === this.expectedArrivalCount) {
      this.reached = true;
      this.release();
    }
    await this.releasePromise;
  }

  private release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    this.releasePromiseResolve();
  }
}

class LoadTestEmbeddingService implements EmbeddingService {
  private activeInputBytes = 0;
  private activeVectors = 0;
  private delayMs: number;
  private firstWaveArrivals = 0;
  private readonly firstWaveRelease: Promise<void>;
  private readonly firstWaveSize: number;
  private generationCount = 0;
  private readonly releaseFirstWave: () => void;
  firstWaveRendezvousReached = false;
  peakInputBytesInFlight = 0;
  peakVectorsInFlight = 0;

  constructor(
    delayMs: number,
    private readonly accelerateAfterFirstGeneration = false,
    firstWaveSize = 1
  ) {
    if (!(Number.isInteger(firstWaveSize) && firstWaveSize > 0)) {
      throw new Error(
        `Load-test first-wave size must be a positive integer, got ${firstWaveSize}.`
      );
    }
    this.delayMs = delayMs;
    this.firstWaveSize = firstWaveSize;
    if (firstWaveSize === 1) {
      this.firstWaveArrivals = 1;
      this.firstWaveRelease = Promise.resolve();
      this.releaseFirstWave = () => {};
      this.firstWaveRendezvousReached = true;
      return;
    }
    let releaseFirstWave = (): void => {};
    this.firstWaveRelease = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    this.releaseFirstWave = releaseFirstWave;
  }

  getSuggestedClaimLimit(): number {
    // Only the adaptive scenario installs this resolver; fixed-size matrix
    // scenarios never consult the model-delay heuristic.
    return this.delayMs > 10 ? 1 : MAX_IN_FLIGHT_JOBS;
  }

  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    return Promise.resolve();
  }

  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    return {
      dimensions: EMBEDDING_DIMENSIONS,
      embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.1),
      model: 'load-test-model',
      usage: { totalTokens: 1 },
    };
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    const inputBytes = texts.reduce(
      (total, text) => total + TEXT_ENCODER.encode(text).byteLength,
      0
    );
    this.activeInputBytes += inputBytes;
    this.activeVectors += texts.length;
    this.peakInputBytesInFlight = Math.max(this.peakInputBytesInFlight, this.activeInputBytes);
    this.peakVectorsInFlight = Math.max(this.peakVectorsInFlight, this.activeVectors);

    try {
      await this.waitForFirstWave();
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return await Promise.all(texts.map((text) => this.generateEmbedding(text)));
    } finally {
      this.activeInputBytes -= inputBytes;
      this.activeVectors -= texts.length;
      this.generationCount += 1;
      if (this.accelerateAfterFirstGeneration && this.generationCount === 1) {
        this.delayMs = 1;
      }
    }
  }

  async generateEmbeddingsStream(
    texts: string[],
    onBatch: (batch: {
      endIndex: number;
      results: EmbeddingResult[];
      startIndex: number;
    }) => Promise<void> | void
  ): Promise<void> {
    const results = await this.generateEmbeddings(texts);
    await onBatch({ endIndex: results.length, results, startIndex: 0 });
  }

  async generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return await this.generateEmbedding(text);
  }

  async generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    return await this.generateEmbedding(text);
  }

  calculateSimilarity(_left: number[], _right: number[]): SimilarityResult {
    return { distance: 0, method: 'cosine', similarity: 1 };
  }

  getStatus(): EmbeddingStatus {
    return 'ready';
  }

  getConfig(): EmbeddingConfig {
    return { modelId: 'load-test-model' };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  get firstWaveArrivalCount(): number {
    return this.firstWaveArrivals;
  }

  private async waitForFirstWave(): Promise<void> {
    if (this.firstWaveRendezvousReached) {
      return;
    }
    this.firstWaveArrivals += 1;
    if (this.firstWaveArrivals === this.firstWaveSize) {
      this.firstWaveRendezvousReached = true;
      this.releaseFirstWave();
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.firstWaveRelease,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Timed out waiting for embedding load first wave: ${this.firstWaveArrivals}/${this.firstWaveSize} arrivals.`
              )
            );
          }, FIRST_WAVE_RENDEZVOUS_TIMEOUT_MS);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const startedAt = performance.now();
  while (!(await condition())) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the embedding load scenario.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function seedEmbeddingJobs(db: PGlite, scenario: string): Promise<void> {
  const now = new Date().toISOString();
  const setId = `set-${scenario}`;
  const fileId = `file-${scenario}`;
  await db.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
     VALUES ($1, $2, 'load-test-model', $3, 'cosine', $4)`,
    [setId, MODEL_KEY, EMBEDDING_DIMENSIONS, now]
  );
  await db.query(
    `INSERT INTO file_records
       (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
     VALUES ($1, $2, $3, 1024, 'load fixture', $4, 12, $5, $5)`,
    [fileId, `${scenario}.ts`, `/${scenario}.ts`, `file-hash-${scenario}`, now]
  );

  const queue = new JobQueue(db as unknown as IDatabase);
  const contentHashes = Array.from(
    { length: JOB_COUNT },
    (_, index) => `content-hash-${scenario}-${index}`
  );
  const embeddingInputHashes = await buildEmbeddingJobInputHashes(contentHashes, MODEL_KEY);
  for (let index = 0; index < JOB_COUNT; index += 1) {
    const chunkId = `chunk-${scenario}-${index}`;
    const content = `${scenario}:${index}:${'x'.repeat(256)}`;
    const contentHash = contentHashes[index];
    const embeddingInputHash = embeddingInputHashes[index];
    if (!(contentHash && embeddingInputHash)) {
      throw new Error(`Missing load-test identity for chunk '${chunkId}'.`);
    }
    await db.query(
      `INSERT INTO file_chunks
         (id, file_record_id, chunk_index, content, content_hash, token_count,
          chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 12, 'text', 256, $6, $6)`,
      [chunkId, fileId, index, content, contentHash, now]
    );
    await queue.enqueue({
      dedupeKey: `${chunkId}:${setId}:${contentHash}`,
      jobType: 'embed_chunk',
      payload: {
        chunkId,
        embeddingInputHash,
        embeddingSetId: setId,
        expectedDimension: EMBEDDING_DIMENSIONS,
        modelKey: MODEL_KEY,
        sourceContentHash: contentHash,
      },
      queue: 'embeddings',
    });
  }
}

// BST-1221: every scenario used to allocate (and close) its own memory://
// PGlite. Closing a PGlite does NOT tear the WASM instance down synchronously —
// finalization is GC-driven and lands during the NEXT scenario's WASM
// instantiation + load churn. On the PKU-enabled Linux x64 CI runners that
// interleaved teardown/instantiation window is where V8's ThreadIsolation
// jit-page bookkeeping fatal (`jit_page_->allocations_.erase(addr) == 1`)
// repeatedly killed this file's fork. One shared instance, allocated lazily on
// first use and closed once in afterAll, keeps the whole file at a single WASM
// instantiate/teardown cycle. Scenario state stays disjoint via
// scenario-prefixed row ids and dedupe keys, and the queue assertions below
// scope their SQL to the scenario's dedupe-key prefix.
let sharedLoadDb: PGlite | undefined;

async function acquireSharedLoadDb(): Promise<PGlite> {
  if (!sharedLoadDb) {
    const db = await wasmLoader.createPGlite('memory://embedding-queue-load');
    try {
      await migrate(db);
    } catch (error) {
      // A failed migration must not leak this instance: `sharedLoadDb` is
      // still unset, so `afterAll` has nothing to close, and PGlite's own
      // teardown is GC-driven finalization that lands during the NEXT test
      // file's WASM instantiation — exactly the interleaved-teardown fatal
      // this shared-instance pattern exists to eliminate. Close it here and
      // rethrow the migrate error UNCHANGED; never swallow it.
      await db.close();
      throw error;
    }
    sharedLoadDb = db;
  }
  return sharedLoadDb;
}

async function runLoadScenario(params: {
  readonly adaptive: boolean;
  readonly concurrency: number;
  readonly scenario: string;
}): Promise<QueueLoadMetrics> {
  const firstWaveSize = params.adaptive ? 1 : Math.min(params.concurrency, MAX_IN_FLIGHT_JOBS);
  if (JOB_COUNT < firstWaveSize) {
    throw new Error(
      `Embedding load scenarios require one job per first-wave loop: ${JOB_COUNT} jobs for a first wave of ${firstWaveSize}.`
    );
  }
  const workerLoopRendezvous = new WorkerLoopRendezvous(params.concurrency);
  const db = await acquireSharedLoadDb();
  let restoreQueueSpies: (() => void) | undefined;
  let stopWorker: (() => Promise<void>) | undefined;

  try {
    await seedEmbeddingJobs(db, params.scenario);

    const service = new LoadTestEmbeddingService(
      params.adaptive ? 25 : 0,
      params.adaptive,
      firstWaveSize
    );
    const adaptiveClaimLimits: number[] = [];
    const claimedBatchSizes: number[] = [];
    const claimLimits: number[] = [];
    const activeClaimedJobIds = new Set<string>();
    let leaseClaimCount = 0;
    let peakClaimedJobs = 0;
    const originalClaimMany = JobQueue.prototype.claimMany;
    const originalCompleteBatch = JobQueue.prototype.completeBatch;
    const originalCompleteEmbeddingChunkBatch = JobQueue.prototype.completeEmbeddingChunkBatch;
    const claimSpy = vi.spyOn(JobQueue.prototype, 'claimMany').mockImplementation(async function (
      this: JobQueue,
      claimParams
    ) {
      const jobs = await originalClaimMany.call(this, claimParams);
      leaseClaimCount += jobs.length;
      if (jobs.length > 0) {
        if (typeof claimParams.limit !== 'number') {
          throw new Error('Embedding worker claimed load-test jobs without an explicit limit.');
        }
        claimLimits.push(claimParams.limit);
        claimedBatchSizes.push(jobs.length);
        for (const job of jobs) {
          activeClaimedJobIds.add(job.id);
        }
        peakClaimedJobs = Math.max(peakClaimedJobs, activeClaimedJobIds.size);
      }
      return jobs;
    });
    const completeBatchSpy = vi
      .spyOn(JobQueue.prototype, 'completeBatch')
      .mockImplementation(async function (this: JobQueue, completionParams) {
        const completedJobs = await originalCompleteBatch.call(this, completionParams);
        for (const job of completedJobs) {
          activeClaimedJobIds.delete(job.id);
        }
        return completedJobs;
      });
    const completionSpy = vi
      .spyOn(JobQueue.prototype, 'completeEmbeddingChunkBatch')
      .mockImplementation(async function (this: JobQueue, completionParams) {
        const completedJobs = await originalCompleteEmbeddingChunkBatch.call(
          this,
          completionParams
        );
        for (const job of completedJobs) {
          activeClaimedJobIds.delete(job.id);
        }
        return completedJobs;
      });
    restoreQueueSpies = () => {
      claimSpy.mockRestore();
      completeBatchSpy.mockRestore();
      completionSpy.mockRestore();
    };

    const startedAt = performance.now();
    const controller = await startEmbeddingWorker({
      claimBatchSize: params.adaptive ? MAX_IN_FLIGHT_JOBS : 1,
      concurrency: params.concurrency,
      db: db as unknown as IDatabase,
      heartbeatIntervalMs: LOAD_TEST_HEARTBEAT_INTERVAL_MS,
      idlePollInitialMs: 5,
      idlePollMaxMs: 20,
      // This is 40x the slowest synthetic inference delay, allows four
      // heartbeat renewals per lease, and bounds the worker stop fallback to
      // one second per scenario on a contended host.
      leaseMs: LOAD_TEST_LEASE_MS,
      log: () => {},
      maxInFlightJobs: MAX_IN_FLIGHT_JOBS,
      metricsIntervalMs: 5000,
      modelKey: 'load-test-model',
      ...(params.adaptive
        ? {
            resolveClaimBatchSize: async () => {
              const limit = service.getSuggestedClaimLimit();
              adaptiveClaimLimits.push(limit);
              return limit;
            },
          }
        : {}),
      service,
      waitForBackgroundPermit: async () => {
        await workerLoopRendezvous.wait();
      },
    });
    stopWorker = () => controller.stop();

    // The trailing '-' keeps prefixes disjoint on the shared queue: without it
    // 'chunk-load-c1' would also match every 'chunk-load-c16' row.
    const scenarioDedupePrefix = `chunk-${params.scenario}-%`;
    await waitFor(async () => {
      const result = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM job_queue
          WHERE queue = 'embeddings' AND state = 'succeeded' AND dedupe_key LIKE $1`,
        [scenarioDedupePrefix]
      );
      return result.rows[0]?.count === JOB_COUNT;
    }, SCENARIO_COMPLETION_TIMEOUT_MS);

    const attempts = await db.query<{ max_attempts: number; total_attempts: number }>(
      `SELECT
         MAX(attempts)::int AS max_attempts,
         SUM(attempts)::int AS total_attempts
       FROM job_queue
       WHERE queue = 'embeddings' AND dedupe_key LIKE $1`,
      [scenarioDedupePrefix]
    );
    expect(attempts.rows[0]?.total_attempts).toBe(JOB_COUNT);
    // Every claimed job must leave through one of the spied successful exits.
    expect(activeClaimedJobIds.size).toBe(0);

    return {
      adaptiveClaimLimits,
      claimedBatchSizes,
      claimLimits,
      completionLatencyMs: performance.now() - startedAt,
      concurrency: params.concurrency,
      firstWaveArrivalCount: service.firstWaveArrivalCount,
      firstWaveRendezvousReached: service.firstWaveRendezvousReached,
      jobCount: JOB_COUNT,
      leaseClaimCount,
      maxAttempts: attempts.rows[0]?.max_attempts ?? 0,
      peakClaimedJobs,
      peakInputBytesInFlight: service.peakInputBytesInFlight,
      peakVectorsInFlight: service.peakVectorsInFlight,
      workerLoopArrivalCount: workerLoopRendezvous.arrivals,
      workerLoopRendezvousReached: workerLoopRendezvous.reached,
    };
  } finally {
    workerLoopRendezvous.dispose();
    if (stopWorker) {
      await stopWorker();
    }
    restoreQueueSpies?.();
  }
}

describe('embedding queue load matrix', { concurrent: false }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    const db = sharedLoadDb;
    sharedLoadDb = undefined;
    if (db) {
      await db.close();
    }
  });

  it('rejects invalid concurrency before allocating PGlite', async () => {
    const createPGliteSpy = vi.spyOn(wasmLoader, 'createPGlite').mockImplementation(async () => {
      throw new Error('PGlite allocation should not be reached.');
    });

    await expect(
      runLoadScenario({ adaptive: false, concurrency: 0, scenario: 'invalid-concurrency' })
    ).rejects.toThrow('Load-test worker-loop rendezvous requires a positive integer');
    expect(createPGliteSpy).not.toHaveBeenCalled();
  });

  it(
    'bounds working sets and lease churn with 1, 2, 4, and 16 worker loops',
    async () => {
      const concurrencyLevels = [1, 2, 4, 16] as const;
      const results: QueueLoadMetrics[] = [];

      for (const concurrency of concurrencyLevels) {
        const result = await runLoadScenario({
          adaptive: false,
          concurrency,
          scenario: `load-c${concurrency}`,
        });
        results.push(result);

        expect(result.leaseClaimCount).toBe(JOB_COUNT);
        expect(result.maxAttempts).toBe(1);
        expect(result.workerLoopRendezvousReached).toBe(true);
        expect(result.workerLoopArrivalCount).toBe(concurrency);
        expect(result.firstWaveRendezvousReached).toBe(true);
        const expectedPeak = Math.min(concurrency, MAX_IN_FLIGHT_JOBS);
        expect(result.firstWaveArrivalCount).toBe(expectedPeak);
        expect(result.peakClaimedJobs).toBe(expectedPeak);
        expect(result.peakVectorsInFlight).toBe(expectedPeak);
        expect(result.peakInputBytesInFlight).toBeGreaterThan(0);
        expect(result.claimLimits).toHaveLength(JOB_COUNT);
        expect(result.claimLimits.every((limit) => limit === 1)).toBe(true);
        expect(result.claimedBatchSizes).toHaveLength(JOB_COUNT);
        expect(result.claimedBatchSizes.every((size) => size === 1)).toBe(true);
      }

      console.info('BST-387 embedding queue load matrix', JSON.stringify(results));
    },
    LOAD_TEST_TIMEOUT_MS
  );

  it(
    'reduces then expands claim limits as modeled throughput improves',
    async () => {
      const result = await runLoadScenario({
        adaptive: true,
        concurrency: 2,
        scenario: 'adaptive-throughput',
      });

      expect(result.adaptiveClaimLimits[0]).toBe(1);
      expect(result.adaptiveClaimLimits).toContain(MAX_IN_FLIGHT_JOBS);
      expect(result.claimLimits[0]).toBe(1);
      expect(result.claimedBatchSizes[0]).toBe(1);
      expect(result.claimLimits.some((limit) => limit > 1)).toBe(true);
      expect(result.claimedBatchSizes.some((size) => size > 1)).toBe(true);
      // Two loops with a one-job claim limit can peak at only 2. Reaching at
      // least 3 proves a later claim consumed the accelerated resolver policy
      // without requiring a timing-sensitive exact overlap of all four slots.
      expect(result.peakClaimedJobs).toBeGreaterThanOrEqual(3);
      expect(result.peakClaimedJobs).toBeLessThanOrEqual(MAX_IN_FLIGHT_JOBS);
      expect(result.peakVectorsInFlight).toBeGreaterThanOrEqual(3);
      expect(result.peakVectorsInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT_JOBS);
      expect(result.leaseClaimCount).toBe(JOB_COUNT);
      expect(result.maxAttempts).toBe(1);
      expect(result.workerLoopRendezvousReached).toBe(true);
      expect(result.workerLoopArrivalCount).toBe(2);
    },
    LOAD_TEST_TIMEOUT_MS
  );
});
