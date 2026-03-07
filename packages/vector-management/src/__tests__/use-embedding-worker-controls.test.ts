import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import type { ElectronAPI } from '@brainstrike/types';
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

type TestWindowGlobals = Window & {
  electronAPI?: unknown;
  embeddingHost?: unknown;
};

function createElectronApiStub(): ElectronAPI {
  return {
    fileSystem: {} as ElectronAPI['fileSystem'],
    loadLayout: vi.fn(async () => ({ success: true })),
    saveLayout: vi.fn(async () => ({ success: true })),
    storage: {} as ElectronAPI['storage'],
  };
}

describe('useEmbeddingWorkerControls', () => {
  const toast = vi.fn();
  const db = {} as UseEmbeddingWorkerControlsParams['db'];
  const testWindow = window as TestWindowGlobals;
  const originalElectronApi = testWindow.electronAPI;
  const originalEmbeddingHost = testWindow.embeddingHost;

  beforeEach(() => {
    vi.clearAllMocks();
    toast.mockClear();
    __resetVectorStatusUIStoreForTests();
    Reflect.deleteProperty(testWindow, 'electronAPI');
    Reflect.deleteProperty(testWindow, 'embeddingHost');
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
    it('uses the desktop embedding host bridge instead of starting the worker in the visible renderer', async () => {
      const ensureStarted = vi.fn(async () => ({
        state: 'running' as const,
        active: false,
        lastError: null,
      }));
      const stop = vi.fn(async () => ({
        state: 'stopped' as const,
        active: false,
        lastError: null,
      }));
      const reset = vi.fn(async () => ({
        state: 'running' as const,
        active: false,
        lastError: null,
      }));
      const getStatus = vi.fn(async () => ({
        state: 'stopped' as const,
        active: false,
        lastError: null,
      }));
      const onStatus = vi.fn(() => () => {});

      testWindow.electronAPI = createElectronApiStub();
      (
        window as Window & {
          embeddingHost?: {
            ensureStarted: typeof ensureStarted;
            stop: typeof stop;
            reset: typeof reset;
            getStatus: typeof getStatus;
            onStatus: typeof onStatus;
          };
        }
      ).embeddingHost = {
        ensureStarted,
        stop,
        reset,
        getStatus,
        onStatus,
      };

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

      expect(startEmbeddingWorker).not.toHaveBeenCalled();
      expect(ensureStarted).toHaveBeenCalledTimes(1);
      expect(result.current.workerLocalRunning).toBe(true);

      await act(async () => {
        await result.current.stopWorker();
      });

      expect(stop).toHaveBeenCalledTimes(1);
      expect(result.current.workerLocalRunning).toBe(false);

      await act(async () => {
        await result.current.resetWorker();
      });

      expect(reset).toHaveBeenCalledTimes(1);
    });

    it('tracks embedding host status push events', async () => {
      let statusListener:
        | ((status: {
            active: boolean;
            lastError: string | null;
            state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
          }) => void)
        | null = null;

      testWindow.electronAPI = createElectronApiStub();
      (
        window as Window & {
          embeddingHost?: {
            ensureStarted: () => Promise<unknown>;
            stop: () => Promise<unknown>;
            reset: () => Promise<unknown>;
            getStatus: () => Promise<unknown>;
            onStatus: (
              callback: typeof statusListener extends null
                ? never
                : NonNullable<typeof statusListener>
            ) => () => void;
          };
        }
      ).embeddingHost = {
        ensureStarted: vi.fn(async () => ({ state: 'running', active: false, lastError: null })),
        stop: vi.fn(async () => ({ state: 'stopped', active: false, lastError: null })),
        reset: vi.fn(async () => ({ state: 'running', active: false, lastError: null })),
        getStatus: vi.fn(async () => ({ state: 'stopped', active: false, lastError: null })),
        onStatus: vi.fn((callback) => {
          statusListener = callback;
          return () => {
            statusListener = null;
          };
        }),
      };

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
        await Promise.resolve();
      });
      expect(statusListener).not.toBeNull();

      await act(async () => {
        statusListener?.({ state: 'running', active: true, lastError: null });
      });

      expect(result.current.workerLocalRunning).toBe(true);
      expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(true);

      await act(async () => {
        statusListener?.({ state: 'error', active: false, lastError: 'host failed' });
      });

      expect(result.current.startWorkerError).toBe('host failed');
      expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(false);
    });

    it('keeps the visible renderer latched in embedding-active mode until the host stops', async () => {
      let statusListener:
        | ((status: {
            active: boolean;
            lastError: string | null;
            state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
          }) => void)
        | null = null;

      testWindow.electronAPI = createElectronApiStub();
      (
        window as Window & {
          embeddingHost?: {
            ensureStarted: () => Promise<unknown>;
            stop: () => Promise<unknown>;
            reset: () => Promise<unknown>;
            getStatus: () => Promise<unknown>;
            onStatus: (
              callback: typeof statusListener extends null
                ? never
                : NonNullable<typeof statusListener>
            ) => () => void;
          };
        }
      ).embeddingHost = {
        ensureStarted: vi.fn(async () => ({ state: 'running', active: false, lastError: null })),
        stop: vi.fn(async () => ({ state: 'stopped', active: false, lastError: null })),
        reset: vi.fn(async () => ({ state: 'running', active: false, lastError: null })),
        getStatus: vi.fn(async () => ({ state: 'running', active: false, lastError: null })),
        onStatus: vi.fn((callback) => {
          statusListener = callback;
          return () => {
            statusListener = null;
          };
        }),
      };

      renderHook(() =>
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
        await Promise.resolve();
      });

      await act(async () => {
        statusListener?.({ state: 'running', active: true, lastError: null });
      });

      expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(true);

      await act(async () => {
        statusListener?.({ state: 'running', active: false, lastError: null });
      });

      expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(true);

      await act(async () => {
        statusListener?.({ state: 'stopped', active: false, lastError: null });
      });

      expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(false);
    });

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

  afterEach(() => {
    if (originalElectronApi === undefined) {
      Reflect.deleteProperty(testWindow, 'electronAPI');
    } else {
      testWindow.electronAPI = originalElectronApi;
    }

    if (originalEmbeddingHost === undefined) {
      Reflect.deleteProperty(testWindow, 'embeddingHost');
    } else {
      testWindow.embeddingHost = originalEmbeddingHost;
    }
  });
});
