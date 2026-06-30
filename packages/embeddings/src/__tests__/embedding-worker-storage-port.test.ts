import type { Job } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index';
import { formatProviderModelKey } from '../provider-utils';
import type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  SimilarityResult,
} from '../types';
import type {
  EmbeddingWorkerJobLeaseRef,
  EmbeddingWorkerStorage,
} from '../worker/embedding-worker-storage';

class FakeStreamingEmbeddingService implements EmbeddingService {
  private status: EmbeddingStatus = 'ready';

  initialize(
    _config?: Partial<EmbeddingConfig>,
    _onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<void> {
    this.status = 'ready';
    return Promise.resolve();
  }

  async generateEmbedding(_text: string): Promise<EmbeddingResult> {
    return {
      dimensions: 3,
      embedding: [0.1, 0.2, 0.3],
      model: 'fake-model',
      usage: { totalTokens: 1 },
    };
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((text) => this.generateEmbedding(text)));
  }

  async generateEmbeddingsStream(
    texts: string[],
    onBatch: (batch: {
      endIndex: number;
      results: EmbeddingResult[];
      startIndex: number;
    }) => Promise<void> | void
  ): Promise<void> {
    await onBatch({
      endIndex: texts.length,
      results: await this.generateEmbeddings(texts),
      startIndex: 0,
    });
  }

  async generateDocEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }

  async generateQueryEmbedding(text: string): Promise<EmbeddingResult> {
    return this.generateEmbedding(text);
  }

  calculateSimilarity(_e1: number[], _e2: number[]): SimilarityResult {
    return { distance: 0, method: 'cosine', similarity: 1 };
  }

  getStatus(): EmbeddingStatus {
    return this.status;
  }

  getConfig(): EmbeddingConfig {
    return { modelId: 'fake-model' };
  }

  async dispose(): Promise<void> {
    this.status = 'disposed';
  }
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 10
): Promise<void> {
  const startedAt = Date.now();
  while (!(await fn())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function createClaimedJob(): Job & { lease_token: string } {
  return {
    attempts: 1,
    backoff_ms: 0,
    chunk_id: 'chunk-1',
    created_at: '2026-06-30T00:00:00.000Z',
    dedupe_key: null,
    embedding_set_id: 'set-1',
    error: null,
    id: 'job-1',
    jobType: 'embed_chunk',
    lease_token: 'lease-1',
    leasedUntil: '2026-06-30T00:01:00.000Z',
    max_attempts: 3,
    payload: {
      chunkId: 'chunk-1',
      embeddingSetId: 'set-1',
      expectedDimension: 3,
      modelKey: formatProviderModelKey('local', 'fake-model'),
    },
    queue: 'embeddings',
    runAt: '2026-06-30T00:00:00.000Z',
    state: 'running',
    updated_at: '2026-06-30T00:00:00.000Z',
    worker_id: 'worker-1',
  };
}

describe('embedding worker storage port', () => {
  it('can process a claimed job through injected storage without a raw PGlite db handle', async () => {
    const claimedJob = createClaimedJob();
    let claimed = false;
    const completeEmbeddingChunkBatch = vi.fn(async () => [
      { ...claimedJob, state: 'succeeded' as const },
    ]);
    const storage: EmbeddingWorkerStorage = {
      assertEmbeddingStorageReady: vi.fn(async () => {}),
      createStatsRefreshController: vi.fn(() => ({
        flush: vi.fn(async () => {}),
        flushIfDue: vi.fn(async () => {}),
        recordCompletions: vi.fn(async () => {}),
      })),
      getModelConfig: vi.fn(async () => ({
        description: 'Fake model for storage-port tests',
        dimensions: 3,
        id: 'fake-model',
        name: 'Fake Model',
        origin: 'local',
        quantized: false,
        tags: ['local', 'embedding'],
      })),
      loadChunksByIds: vi.fn(async (ids: readonly string[]) =>
        ids.map((id) => ({
          content: 'export const value = 1;',
          contentHash: 'chunk-hash',
          embeddingHash: null,
          embeddingSetId: 'set-1',
          id,
        }))
      ),
      queue: {
        claimMany: vi.fn(async () => {
          if (claimed) {
            return [];
          }
          claimed = true;
          return [claimedJob];
        }),
        completeBatch: vi.fn(async (jobs: EmbeddingWorkerJobLeaseRef[]) =>
          jobs.map((job) => ({ ...claimedJob, id: job.id, state: 'succeeded' as const }))
        ),
        completeEmbeddingChunkBatch,
        fail: vi.fn(async () => null),
        failBatch: vi.fn(async () => []),
        heartbeatBatch: vi.fn(async (jobs: EmbeddingWorkerJobLeaseRef[]) =>
          jobs.map((job) => ({ ...claimedJob, id: job.id, state: 'running' as const }))
        ),
      },
      resolveEmbeddingSetDimension: vi.fn(async () => 3),
    };

    const controller = await startEmbeddingWorker({
      claimBatchSize: 1,
      idlePollInitialMs: 1,
      idlePollMaxMs: 1,
      interBatchDelayMs: 1,
      leaseMs: 60_000,
      log: () => {},
      modelKey: formatProviderModelKey('local', 'fake-model'),
      service: new FakeStreamingEmbeddingService(),
      storage,
    });

    await waitFor(() => completeEmbeddingChunkBatch.mock.calls.length > 0);
    await controller.stop();

    expect(storage.assertEmbeddingStorageReady).toHaveBeenCalledTimes(1);
    expect(storage.loadChunksByIds).toHaveBeenCalledWith(['chunk-1']);
    expect(storage.resolveEmbeddingSetDimension).toHaveBeenCalledWith('set-1');
    expect(completeEmbeddingChunkBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        chunkId: 'chunk-1',
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: 'set-1',
        id: 'job-1',
        leaseToken: 'lease-1',
      }),
    ]);
  });
});
