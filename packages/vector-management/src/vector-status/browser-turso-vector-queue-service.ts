import type { BrainstrikeDbExecutionClient, EmbeddingSet } from '@brainstrike/db';
import { TursoJobQueue } from '@brainstrike/db';
import { createTursoEmbeddingBackfillRepository } from './turso-embedding-backfill-repository';
import { createTursoVectorQueueMetricsRepository } from './turso-vector-queue-metrics-repository';
import {
  createVectorQueueService,
  type VectorQueueDatabase,
  type VectorQueueService,
} from './vector-queue-service';

interface BrowserTursoVectorQueueChunkRepository {
  clearEmbeddingsForSet(embeddingSetId: string): Promise<number>;
  countEmbeddingBackfillCandidates(
    embeddingSetId: string,
    options?: { readonly queue?: string }
  ): Promise<number>;
  findEmbeddingBackfillCandidates(
    options: Parameters<
      Parameters<
        typeof createTursoEmbeddingBackfillRepository
      >[0]['chunkRepository']['findEmbeddingBackfillCandidates']
    >[0]
  ): ReturnType<
    Parameters<
      typeof createTursoEmbeddingBackfillRepository
    >[0]['chunkRepository']['findEmbeddingBackfillCandidates']
  >;
  getCoverageForSet(
    setId: string
  ): Promise<{ chunksWithEmbeddingsForSet: number; totalChunks: number }>;
  getEmbeddingBackfillCandidateDiagnostics(
    embeddingSetId: string,
    options?: { readonly queue?: string }
  ): ReturnType<
    Parameters<
      typeof createTursoEmbeddingBackfillRepository
    >[0]['chunkRepository']['getEmbeddingBackfillCandidateDiagnostics']
  >;
}

export interface BrowserTursoVectorQueueServiceDependencies {
  readonly chunkRepository: BrowserTursoVectorQueueChunkRepository;
  readonly db: VectorQueueDatabase;
  readonly embeddingSetsRepository: {
    getById(id: string): Promise<Pick<EmbeddingSet, 'dimensions' | 'modelKey'> | null>;
  };
  readonly executionClient: BrainstrikeDbExecutionClient;
}

/**
 * Returns true when a provider chunk repository carries the full browser
 * Turso backfill surface (coverage + clear + backfill candidate reads). Used
 * as the capability gate before composing the browser vector queue service —
 * a repository without it keeps the service unavailable (fail closed with the
 * existing `missing-turso-vector-queue-adapter` diagnostics), never a partial
 * service.
 */
export function isBrowserTursoVectorQueueChunkRepository(
  candidate: unknown
): candidate is BrowserTursoVectorQueueChunkRepository {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const repository = candidate as Record<string, unknown>;
  return (
    typeof repository['clearEmbeddingsForSet'] === 'function' &&
    typeof repository['countEmbeddingBackfillCandidates'] === 'function' &&
    typeof repository['findEmbeddingBackfillCandidates'] === 'function' &&
    typeof repository['getCoverageForSet'] === 'function' &&
    typeof repository['getEmbeddingBackfillCandidateDiagnostics'] === 'function'
  );
}

/**
 * Browser Turso vector queue service (A7 cutover): the browser has no
 * desktop owner IPC (`tursoVectorQueueAction` bridge), and no hidden desktop
 * embedding host to own backfill — the provider-owned WAL single-writer
 * execution client IS the owner. This composes the SAME generic vector queue
 * service the PGlite renderer path uses, with the Turso building blocks the
 * desktop host already trusts: `TursoJobQueue` over the owner client for
 * queue mutations, the Turso backfill-candidate repository for candidate
 * scans, and the Turso queue metrics repository for snapshots.
 */
export function createBrowserTursoVectorQueueService(
  dependencies: BrowserTursoVectorQueueServiceDependencies
): VectorQueueService {
  const jobQueue = new TursoJobQueue(dependencies.executionClient);
  return createVectorQueueService({
    backfillRepository: createTursoEmbeddingBackfillRepository({
      chunkRepository: dependencies.chunkRepository,
      embeddingSetsRepository: dependencies.embeddingSetsRepository,
      jobQueue,
    }),
    chunkRepository: dependencies.chunkRepository,
    db: dependencies.db,
    jobQueue,
    queueMetricsRepository: createTursoVectorQueueMetricsRepository({ jobQueue }),
  });
}
