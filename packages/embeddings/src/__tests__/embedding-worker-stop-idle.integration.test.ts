import { JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index.js';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
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
  generateEmbeddingsStream(): Promise<void> {
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
    db = await wasmLoader.createPGlite('memory://embedding-worker-stop-idle');
    await migrate(db);
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
});
