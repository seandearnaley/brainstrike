import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingJobQueueTracker } from '../embedding-job-queue-tracker';
import { useEmbeddingJobQueue } from '../use-embedding-job-queue';

vi.mock('@brainstrike/hooks', () => ({
  isAppActive: vi.fn(() => true),
}));

vi.mock('../use-embedding-job-queue', () => ({
  useEmbeddingJobQueue: vi.fn(),
}));

describe('EmbeddingJobQueueTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetVectorStatusUIStoreForTests();
  });

  it('polls durable queue stats through the runtime-keyed job queue', async () => {
    vi.mocked(useEmbeddingJobQueue).mockReturnValue({
      getQueueStats: vi.fn(async () => [
        {
          queue: 'embeddings',
          queued: 2,
          running: 1,
          failed: 3,
          succeeded: 5,
          nextRunnableAt: '2026-06-24T10:00:00.000Z',
        },
      ]),
    } as never);

    render(<EmbeddingJobQueueTracker />);

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().durableQueueStats).toEqual({
        queued: 2,
        running: 1,
        failed: 3,
        succeeded: 5,
        nextRunnableAt: '2026-06-24T10:00:00.000Z',
      });
    });
    expect(useVectorStatusUIStore.getState().isJobQueueActive).toBe(true);
  });
});
