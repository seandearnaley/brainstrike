import { JobQueue } from '@brainstrike/db';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import { buildEmbeddingInputHash } from '@brainstrike/indexing-contract';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatProviderModelKey, startEmbeddingWorker } from '../index.js';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  EmbeddingStreamOptions,
  SimilarityResult,
} from '../types.js';
import type { EmbeddingAdmissionBudget } from '../worker/embedding-admission-budget.js';

const admissionProbe = vi.hoisted(
  (): {
    budget: EmbeddingAdmissionBudget | undefined;
    onGrant: (() => void) | undefined;
  } => ({ budget: undefined, onGrant: undefined })
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
        tryReserve: async (requested: number): Promise<number> => {
          const granted = await budget.tryReserve(requested);
          if (granted > 0) {
            admissionProbe.onGrant?.();
          }
          return granted;
        },
      };
    },
  };
});

class IdleEmbeddingService implements EmbeddingService {
  private status: EmbeddingStatus = 'ready';
  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }
  generateEmbedding(_text: string): Promise<EmbeddingResult> {
    return Promise.reject(new Error('No jobs are expected in this test.'));
  }
  generateEmbeddings(_texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.reject(new Error('No jobs are expected in this test.'));
  }
  generateEmbeddingsStream(
    ..._args: Parameters<NonNullable<EmbeddingService['generateEmbeddingsStream']>>
  ): Promise<void> {
    return Promise.reject(new Error('No jobs are expected in this test.'));
  }
  generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }
  calculateSimilarity(_e1: number[], _e2: number[]): SimilarityResult {
    return { distance: 0, method: 'cosine', similarity: 1 };
  }
  getStatus(): EmbeddingStatus {
    return this.status;
  }
  getConfig(): EmbeddingConfig {
    return { modelId: 'idle-model' } as unknown as EmbeddingConfig;
  }
  dispose(): Promise<void> {
    this.status = 'disposed';
    return Promise.resolve();
  }
}

async function expectPromptStop(stop: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  try {
    const outcome = await Promise.race([
      stop().then(() => 'stopped' as const),
      new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => resolve('timed-out'), 2000);
      }),
    ]);
    expect(outcome).toBe('stopped');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  } finally {
    clearTimeout(timer);
  }
}

describe('embedding-worker: stop while idle', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    admissionProbe.onGrant = undefined;
    admissionProbe.budget = undefined;
    await db.close();
  });

  it('returns a committed admission grant when Stop arrives before the claim handoff', async () => {
    const entered = Promise.withResolvers<void>();
    const permit = Promise.withResolvers<void>();
    const grantObserved = Promise.withResolvers<void>();
    const claimSpy = vi.spyOn(JobQueue.prototype, 'claimMany');
    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db,
      leaseMs: 1000,
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new IdleEmbeddingService(),
      waitForBackgroundPermit: (): Promise<void> => {
        entered.resolve();
        return permit.promise;
      },
    });
    await entered.promise;
    let stopping: Promise<void> | undefined;
    admissionProbe.onGrant = (): void => {
      stopping = controller.stop();
      grantObserved.resolve();
    };
    try {
      permit.resolve();
      await grantObserved.promise;
      await stopping;
      expect(claimSpy).not.toHaveBeenCalled();
      expect(await admissionProbe.budget?.inFlight()).toBe(0);
    } finally {
      permit.resolve();
      await controller.stop();
      claimSpy.mockRestore();
    }
  });

  it('stops promptly without claiming jobs when its background permit never arrives', async () => {
    const entered = Promise.withResolvers<void>();
    const permit = Promise.withResolvers<void>();
    const logs: string[] = [];
    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db,
      leaseMs: 10_000,
      log: (message) => logs.push(message),
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new IdleEmbeddingService(),
      waitForBackgroundPermit: () => {
        entered.resolve();
        return permit.promise;
      },
    });
    await entered.promise;
    try {
      await expectPromptStop(() => controller.stop());
      expect(logs).not.toContain('embedding_queue_idle_backoff');
    } finally {
      // Release only during failed-test cleanup; Stop must not need this permit.
      permit.resolve();
      await controller.stop();
    }
  });

  it('resolves stop() promptly while the loop is parked in idle backoff', async () => {
    // Desktop graceful shutdown allows 5s for every host; a worker parked in a
    // long idle poll must wake for stop instead of sleeping the poll out.
    const logs: string[] = [];
    const controller = await startEmbeddingWorker({
      concurrency: 1,
      db,
      idlePollInitialMs: 30_000,
      idlePollMaxMs: 30_000,
      log: (msg) => logs.push(msg),
      modelKey: 'jinaai/jina-embeddings-v2-base-code',
      service: new IdleEmbeddingService(),
    });
    for (let i = 0; i < 200 && !logs.includes('embedding_queue_idle_backoff'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(logs).toContain('embedding_queue_idle_backoff');

    await expectPromptStop(() => controller.stop());
  });

  it('cancels an active local stream and leaves its claimed job recoverable', async () => {
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const modelId = 'jinaai/jina-embeddings-v2-base-code';
    const modelKey = formatProviderModelKey('local', modelId);
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ('stop-set', $1, $2, 768, 'cosine', $3)`,
      [modelKey, modelId, now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
       VALUES ('stop-file', 'stop.ts', '/stop.ts', 100, 'content', 'stop-hash', 10, 'stop-set', $1, $1)`,
      [now]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ('stop-chunk', 'stop-file', 0, 'content', 'stop-hash', 10, 'text', 10, $1, $1)`,
      [now]
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ('stop-job', 'embeddings', 'embed_chunk', $1, 'queued', $2, 0, 3, 0, $2, $2)`,
      [
        JSON.stringify({
          chunkId: 'stop-chunk',
          embeddingInputHash: await buildEmbeddingInputHash('stop-hash', modelKey),
          embeddingSetId: 'stop-set',
          expectedDimension: 768,
          modelKey,
          sourceContentHash: 'stop-hash',
        }),
        now,
      ]
    );

    let abortObserved = false;
    class BlockedEmbeddingService extends IdleEmbeddingService {
      override async generateEmbeddingsStream(
        _texts: string[],
        _onBatch: (batch: {
          startIndex: number;
          endIndex: number;
          results: EmbeddingResult[];
        }) => Promise<void> | void,
        options?: EmbeddingStreamOptions
      ): Promise<void> {
        started.resolve();
        await new Promise<void>((resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              abortObserved = true;
              reject(options.signal?.reason);
            },
            { once: true }
          );
          void released.promise.then(resolve);
        });
      }
    }

    const controller = await startEmbeddingWorker({
      db,
      initializeLocalModelOnStart: false,
      leaseMs: 10_000,
      modelKey,
      service: new BlockedEmbeddingService(),
    });
    await started.promise;
    const stopping = controller.stop();
    try {
      await expectPromptStop(() => stopping);
      expect(abortObserved).toBe(true);
      const result = await db.query<{ attempts: number; state: string }>(
        `SELECT state, attempts FROM job_queue WHERE id = 'stop-job'`
      );
      expect(result.rows[0]).toMatchObject({ attempts: 1, state: 'running' });
    } finally {
      released.resolve();
      await stopping;
    }
  });
});
