import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type UseEmbeddingWorkerControlsParams,
  useEmbeddingWorkerControls,
} from '../vector-status/use-embedding-worker-controls';

vi.mock('@brainstrike/embeddings', () => ({
  startEmbeddingWorker: vi.fn(),
}));

import { startEmbeddingWorker } from '@brainstrike/embeddings';

describe('useEmbeddingWorkerControls', () => {
  const toast = vi.fn();
  const db = {} as UseEmbeddingWorkerControlsParams['db'];

  beforeEach(() => {
    vi.clearAllMocks();
    toast.mockClear();
  });

  it('starts the worker and triggers backfill for active set', async () => {
    const stop = vi.fn(async () => {});
    vi.mocked(startEmbeddingWorker).mockResolvedValueOnce({ stop } as {
      stop: () => Promise<void>;
    });
    const onBackfill = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useEmbeddingWorkerControls({
        db,
        devicePreference: 'auto',
        reinitEveryN: 100,
        forceCpuAfterFailures: 3,
        activeEmbeddingSetId: 'set-1',
        onBackfill,
        toast,
      })
    );

    await act(async () => {
      await result.current.startWorker();
    });

    expect(startEmbeddingWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        enable: true,
        reinitEveryN: 100,
        forceCpuAfterFailures: 3,
      })
    );
    expect(onBackfill).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      title: 'Worker started',
      description: 'Local embedding worker is running.',
    });
    expect(result.current.workerLocalRunning).toBe(true);

    await act(async () => {
      await result.current.stopWorker();
    });

    expect(stop).toHaveBeenCalled();
    expect(result.current.workerLocalRunning).toBe(false);
    expect(toast).toHaveBeenLastCalledWith({ title: 'Worker stopped' });
  });

  it('resets the worker by stopping and starting again', async () => {
    const firstStop = vi.fn(async () => {});
    const secondStop = vi.fn(async () => {});
    vi.mocked(startEmbeddingWorker)
      .mockResolvedValueOnce({ stop: firstStop } as { stop: () => Promise<void> })
      .mockResolvedValueOnce({ stop: secondStop } as { stop: () => Promise<void> });

    const onBackfill = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useEmbeddingWorkerControls({
        db,
        devicePreference: 'auto',
        reinitEveryN: 50,
        forceCpuAfterFailures: 2,
        activeEmbeddingSetId: 'set-42',
        onBackfill,
        toast,
      })
    );

    await act(async () => {
      await result.current.startWorker();
    });

    await act(async () => {
      await result.current.resetWorker();
    });

    expect(firstStop).toHaveBeenCalled();
    expect(startEmbeddingWorker).toHaveBeenCalledTimes(2);
    expect(onBackfill).toHaveBeenCalledTimes(2);
    expect(result.current.workerLocalRunning).toBe(true);
    expect(toast).toHaveBeenLastCalledWith({
      title: 'Worker reset',
      description: 'Embedding worker restarted successfully.',
    });

    await act(async () => {
      await result.current.stopWorker();
    });
    expect(secondStop).toHaveBeenCalled();
  });
});
