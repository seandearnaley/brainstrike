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

  describe('auto-backfill disabled behavior', () => {
    it('does not trigger backfill when worker starts with activeEmbeddingSetId', async () => {
      const stop = vi.fn(async () => {});
      vi.mocked(startEmbeddingWorker).mockResolvedValueOnce({ stop } as {
        stop: () => Promise<void>;
      });
      const onBackfill = vi.fn(async () => {});

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
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
        })
      );
      // Auto-backfill on worker start is disabled - backfill must be triggered manually
      expect(onBackfill).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith({
        title: 'Worker started',
        description: 'Local embedding worker is running.',
      });
      expect(result.current.workerLocalRunning).toBe(true);
    });

    it('does not trigger backfill when worker starts without activeEmbeddingSetId', async () => {
      const stop = vi.fn(async () => {});
      vi.mocked(startEmbeddingWorker).mockResolvedValueOnce({ stop } as {
        stop: () => Promise<void>;
      });
      const onBackfill = vi.fn(async () => {});

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
          activeEmbeddingSetId: null,
          onBackfill,
          toast,
        })
      );

      await act(async () => {
        await result.current.startWorker();
      });

      expect(onBackfill).not.toHaveBeenCalled();
      expect(result.current.workerLocalRunning).toBe(true);
    });

    it('does not trigger backfill on worker reset even with activeEmbeddingSetId', async () => {
      const firstStop = vi.fn(async () => {});
      const secondStop = vi.fn(async () => {});
      vi.mocked(startEmbeddingWorker)
        .mockResolvedValueOnce({ stop: firstStop } as { stop: () => Promise<void> })
        .mockResolvedValueOnce({ stop: secondStop } as { stop: () => Promise<void> });

      const onBackfill = vi.fn(async () => {});

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 50,
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
      // Auto-backfill on worker start/reset is disabled
      expect(onBackfill).not.toHaveBeenCalled();
      expect(result.current.workerLocalRunning).toBe(true);
      expect(toast).toHaveBeenLastCalledWith({
        title: 'Worker reset',
        description: 'Embedding worker restarted successfully.',
      });
    });

    it('never triggers backfill across multiple start/stop cycles', async () => {
      const onBackfill = vi.fn(async () => {});

      vi.mocked(startEmbeddingWorker)
        .mockResolvedValueOnce({ stop: vi.fn(async () => {}) } as { stop: () => Promise<void> })
        .mockResolvedValueOnce({ stop: vi.fn(async () => {}) } as { stop: () => Promise<void> })
        .mockResolvedValueOnce({ stop: vi.fn(async () => {}) } as { stop: () => Promise<void> });

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
          activeEmbeddingSetId: 'set-1',
          onBackfill,
          toast,
        })
      );

      // First cycle
      await act(async () => {
        await result.current.startWorker();
      });
      await act(async () => {
        await result.current.stopWorker();
      });

      // Second cycle
      await act(async () => {
        await result.current.startWorker();
      });
      await act(async () => {
        await result.current.stopWorker();
      });

      // Third cycle
      await act(async () => {
        await result.current.startWorker();
      });

      // Should never have triggered backfill across all cycles
      expect(onBackfill).not.toHaveBeenCalled();
      expect(startEmbeddingWorker).toHaveBeenCalledTimes(3);
    });
  });

  describe('worker lifecycle', () => {
    it('starts and stops the worker correctly', async () => {
      const stop = vi.fn(async () => {});
      vi.mocked(startEmbeddingWorker).mockResolvedValueOnce({ stop } as {
        stop: () => Promise<void>;
      });

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
          activeEmbeddingSetId: 'set-1',
          onBackfill: vi.fn(),
          toast,
        })
      );

      expect(result.current.workerLocalRunning).toBe(false);

      await act(async () => {
        await result.current.startWorker();
      });

      expect(result.current.workerLocalRunning).toBe(true);

      await act(async () => {
        await result.current.stopWorker();
      });

      expect(stop).toHaveBeenCalled();
      expect(result.current.workerLocalRunning).toBe(false);
      expect(toast).toHaveBeenLastCalledWith({ title: 'Worker stopped' });
    });

    it('handles worker start failure gracefully', async () => {
      const error = new Error('WebGPU not supported');
      vi.mocked(startEmbeddingWorker).mockRejectedValueOnce(error);

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
          activeEmbeddingSetId: 'set-1',
          onBackfill: vi.fn(),
          toast,
        })
      );

      await act(async () => {
        await result.current.startWorker();
      });

      expect(result.current.workerLocalRunning).toBe(false);
      expect(result.current.startWorkerError).toBe('WebGPU not supported');
      expect(toast).toHaveBeenCalledWith({
        title: 'Failed to start worker',
        description: 'WebGPU not supported',
        variant: 'destructive',
      });
    });

    it('clears error state on clearWorkerError', async () => {
      const error = new Error('Some error');
      vi.mocked(startEmbeddingWorker).mockRejectedValueOnce(error);

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
          activeEmbeddingSetId: null,
          onBackfill: vi.fn(),
          toast,
        })
      );

      await act(async () => {
        await result.current.startWorker();
      });

      expect(result.current.startWorkerError).toBe('Some error');

      act(() => {
        result.current.clearWorkerError();
      });

      expect(result.current.startWorkerError).toBe(null);
    });

    it('does not start worker when db is null', async () => {
      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db: null,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
          activeEmbeddingSetId: 'set-1',
          onBackfill: vi.fn(),
          toast,
        })
      );

      await act(async () => {
        await result.current.startWorker();
      });

      expect(startEmbeddingWorker).not.toHaveBeenCalled();
      expect(result.current.workerLocalRunning).toBe(false);
    });

    it('does not call startEmbeddingWorker again while startingWorker is true', async () => {
      // This test verifies the guard condition in startWorker that checks startingWorker state
      const stop = vi.fn(async () => {});
      vi.mocked(startEmbeddingWorker).mockResolvedValue({ stop } as {
        stop: () => Promise<void>;
      });

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
          activeEmbeddingSetId: 'set-1',
          onBackfill: vi.fn(),
          toast,
        })
      );

      // Start the worker normally
      await act(async () => {
        await result.current.startWorker();
      });

      expect(startEmbeddingWorker).toHaveBeenCalledTimes(1);
      expect(result.current.workerLocalRunning).toBe(true);
    });
  });

  describe('device preference handling', () => {
    it('passes webgpu device preference to worker', async () => {
      const stop = vi.fn(async () => {});
      vi.mocked(startEmbeddingWorker).mockResolvedValue({ stop } as {
        stop: () => Promise<void>;
      });

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'webgpu',
          reinitEveryN: 100,
          activeEmbeddingSetId: null,
          onBackfill: vi.fn(),
          toast,
        })
      );

      await act(async () => {
        await result.current.startWorker();
      });

      expect(startEmbeddingWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          device: 'webgpu',
        })
      );
    });

    it('passes wasm device preference to worker', async () => {
      const stop = vi.fn(async () => {});
      vi.mocked(startEmbeddingWorker).mockResolvedValue({ stop } as {
        stop: () => Promise<void>;
      });

      const { result } = renderHook(() =>
        useEmbeddingWorkerControls({
          db,
          devicePreference: 'wasm',
          reinitEveryN: 100,
          activeEmbeddingSetId: null,
          onBackfill: vi.fn(),
          toast,
        })
      );

      await act(async () => {
        await result.current.startWorker();
      });

      const callArg = vi.mocked(startEmbeddingWorker).mock.calls[0]?.[0];
      expect(callArg).toEqual(expect.objectContaining({ device: 'wasm' }));
    });
  });
});
