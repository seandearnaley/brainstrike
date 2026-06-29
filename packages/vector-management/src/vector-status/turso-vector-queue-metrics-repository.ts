import type {
  QueueCounts,
  VectorQueueMetricsRepository,
  VectorQueueMetricsSnapshot,
  VectorQueueSnapshotReader,
} from './vector-queue-service';
import { createVectorQueueSnapshotReader, EMBEDDINGS_QUEUE } from './vector-queue-service';

interface TursoVectorQueueMetricsJobQueue {
  getQueueMetrics(
    queue: string,
    options: { latencyLimit: number; since: string }
  ): Promise<VectorQueueMetricsSnapshot>;
}

interface TursoVectorQueueSnapshotJobQueue extends TursoVectorQueueMetricsJobQueue {
  getEmbeddingSetQueueCounts(queue: string, embeddingSetId: string): Promise<QueueCounts>;
  getQueueStats(queue?: string): Promise<
    Array<{
      failed: number;
      queue: string;
      queued: number;
      running: number;
      succeeded: number;
    }>
  >;
}

interface TursoVectorQueueCoverageRepository {
  getCoverageForSet(
    setId: string
  ): Promise<{ chunksWithEmbeddingsForSet: number; totalChunks: number }>;
}

export interface TursoVectorQueueMetricsRepositoryDependencies {
  jobQueue: TursoVectorQueueMetricsJobQueue;
}

export interface TursoVectorQueueSnapshotReaderDependencies {
  chunkRepository: TursoVectorQueueCoverageRepository;
  jobQueue: TursoVectorQueueSnapshotJobQueue;
}

export function createTursoVectorQueueMetricsRepository({
  jobQueue,
}: TursoVectorQueueMetricsRepositoryDependencies): VectorQueueMetricsRepository {
  return {
    async loadQueueMetrics({ latencyLimit, queue, since }): Promise<VectorQueueMetricsSnapshot> {
      return jobQueue.getQueueMetrics(queue, { latencyLimit, since });
    },
  };
}

export function createTursoVectorQueueSnapshotReader({
  chunkRepository,
  jobQueue,
}: TursoVectorQueueSnapshotReaderDependencies): VectorQueueSnapshotReader {
  return createVectorQueueSnapshotReader({
    activeSetQueueCountsRepository: {
      getEmbeddingSetQueueCounts: (embeddingSetId) =>
        jobQueue.getEmbeddingSetQueueCounts(EMBEDDINGS_QUEUE, embeddingSetId),
    },
    chunkRepository,
    jobQueue,
    queueMetricsRepository: createTursoVectorQueueMetricsRepository({ jobQueue }),
  });
}
