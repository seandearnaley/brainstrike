import { migrate, wasmLoader } from '@brainstrike/db';
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

describe('embedding-worker: stop while idle', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-worker-stop-idle');
    await migrate(db);
  });

  afterEach(async () => {
    await db.close();
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

    const startedAt = Date.now();
    const outcome = await Promise.race([
      controller.stop().then(() => 'stopped' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 2000)),
    ]);

    expect(outcome).toBe('stopped');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
