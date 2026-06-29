import { describe, expect, it, vi } from 'vitest';
import {
  createTursoVectorQueueMetricsRepository,
  createTursoVectorQueueSnapshotReader,
} from '../vector-status/turso-vector-queue-metrics-repository';

describe('createTursoVectorQueueMetricsRepository', () => {
  it('loads vector queue metrics through the Turso job queue port', async () => {
    const metrics = {
      lastError: 'latest failure',
      latencyRows: [
        {
          runAt: '2026-06-23T08:03:00.000Z',
          updatedAt: '2026-06-23T08:03:30.000Z',
        },
      ],
      throughput: 2,
    };
    const jobQueue = {
      getQueueMetrics: vi.fn(async () => metrics),
    };
    const repository = createTursoVectorQueueMetricsRepository({ jobQueue });

    await expect(
      repository.loadQueueMetrics({
        latencyLimit: 200,
        queue: 'embeddings',
        since: '2026-06-23T08:00:00.000Z',
      })
    ).resolves.toBe(metrics);
    expect(jobQueue.getQueueMetrics).toHaveBeenCalledWith('embeddings', {
      latencyLimit: 200,
      since: '2026-06-23T08:00:00.000Z',
    });
  });

  it('builds a read-only snapshot reader from Turso queue and coverage ports', async () => {
    const jobQueue = {
      getEmbeddingSetQueueCounts: vi.fn(async () => ({
        failed: 1,
        queued: 2,
        running: 3,
        succeeded: 4,
      })),
      getQueueMetrics: vi.fn(async () => ({
        lastError: 'latest failure',
        latencyRows: [
          {
            runAt: '2026-06-23T08:03:00.000Z',
            updatedAt: '2026-06-23T08:03:30.000Z',
          },
        ],
        throughput: 2,
      })),
      getQueueStats: vi.fn(async () => [
        {
          failed: 5,
          queue: 'embeddings',
          queued: 6,
          running: 7,
          succeeded: 8,
        },
      ]),
    };
    const chunkRepository = {
      getCoverageForSet: vi.fn(async () => ({
        chunksWithEmbeddingsForSet: 9,
        totalChunks: 10,
      })),
    };
    const reader = createTursoVectorQueueSnapshotReader({ chunkRepository, jobQueue });

    await expect(reader.refresh('set-1')).resolves.toMatchObject({
      activeSetQueueCounts: { failed: 1, queued: 2, running: 3, succeeded: 4 },
      coverage: { total: 10, withSet: 9 },
      lastError: 'latest failure',
      queueCounts: { failed: 5, queued: 6, running: 7, succeeded: 8 },
      throughput: 2,
    });
    expect(jobQueue.getEmbeddingSetQueueCounts).toHaveBeenCalledWith('embeddings', 'set-1');
    expect(jobQueue.getQueueMetrics).toHaveBeenCalledWith('embeddings', {
      latencyLimit: 200,
      since: expect.any(String),
    });
    expect(chunkRepository.getCoverageForSet).toHaveBeenCalledWith('set-1');
  });
});
