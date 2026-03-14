import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbeddingRuntimeController,
  EmbeddingRuntimeStatus,
} from '../vector-status/embedding-runtime-controller';
import { useEmbeddingWorkerControls } from '../vector-status/use-embedding-worker-controls';

interface MockController {
  readonly controller: EmbeddingRuntimeController;
  readonly emitStatus: (status: EmbeddingRuntimeStatus) => void;
  readonly getStatusMock: ReturnType<typeof vi.fn>;
  readonly resetMock: ReturnType<typeof vi.fn>;
  readonly startMock: ReturnType<typeof vi.fn>;
  readonly stopMock: ReturnType<typeof vi.fn>;
}

function createStatus(
  state: EmbeddingRuntimeStatus['state'],
  overrides?: Partial<EmbeddingRuntimeStatus>
): EmbeddingRuntimeStatus {
  return {
    runtimeKind: 'embedding-worker',
    runtimeId: 'embedding-worker:test',
    state,
    active: false,
    lastError: null,
    ...overrides,
  };
}

function createMockController(
  initialStatus: EmbeddingRuntimeStatus = createStatus('stopped')
): MockController {
  const listeners = new Set<(status: EmbeddingRuntimeStatus) => void>();
  let currentStatus = initialStatus;

  const getStatusMock = vi.fn(async () => currentStatus);
  const startMock = vi.fn(async () => {
    currentStatus = createStatus('running');
    return currentStatus;
  });
  const stopMock = vi.fn(async () => {
    currentStatus = createStatus('stopped');
    return currentStatus;
  });
  const resetMock = vi.fn(async () => {
    currentStatus = createStatus('running');
    return currentStatus;
  });

  return {
    controller: {
      enqueueBackfill: vi.fn(async () => {}),
      ensureStarted: startMock,
      getStatus: getStatusMock,
      onBackfillProgress: () => () => {},
      onStatus: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
      reset: resetMock,
      start: startMock,
      stop: stopMock,
    },
    emitStatus: (status) => {
      currentStatus = status;
      for (const listener of listeners) {
        listener(status);
      }
    },
    getStatusMock,
    resetMock,
    startMock,
    stopMock,
  };
}

describe('useEmbeddingWorkerControls', () => {
  const toast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    toast.mockReset();
    __resetVectorStatusUIStoreForTests();
  });

  it('hydrates from controller status and mirrors active work into the UI store', async () => {
    const mockController = createMockController(createStatus('running', { active: true }));

    const { result } = renderHook(() =>
      useEmbeddingWorkerControls({
        controller: mockController.controller,
        activeEmbeddingSetId: 'set-1',
        onBackfill: vi.fn(async () => {}),
        toast,
      })
    );

    await waitFor(() => {
      expect(result.current.workerLocalRunning).toBe(true);
    });
    expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(true);

    act(() => {
      mockController.emitStatus(createStatus('stopped'));
    });

    await waitFor(() => {
      expect(result.current.workerLocalRunning).toBe(false);
    });
    expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(false);
  });

  it('starts the controller runtime and shows success toast', async () => {
    const mockController = createMockController();

    const { result } = renderHook(() =>
      useEmbeddingWorkerControls({
        controller: mockController.controller,
        activeEmbeddingSetId: null,
        onBackfill: vi.fn(async () => {}),
        toast,
      })
    );

    await act(async () => {
      await result.current.startWorker();
    });

    expect(mockController.startMock).toHaveBeenCalledTimes(1);
    expect(result.current.workerLocalRunning).toBe(true);
    expect(toast).toHaveBeenCalledWith({
      title: 'Worker started',
      description: 'Local embedding worker is running.',
    });
  });

  it('surfaces controller start failures without swallowing them', async () => {
    const mockController = createMockController();
    mockController.startMock.mockRejectedValueOnce(new Error('runtime start failed'));

    const { result } = renderHook(() =>
      useEmbeddingWorkerControls({
        controller: mockController.controller,
        activeEmbeddingSetId: null,
        onBackfill: vi.fn(async () => {}),
        toast,
      })
    );

    await act(async () => {
      await expect(result.current.startWorker()).rejects.toThrow('runtime start failed');
    });

    expect(result.current.startWorkerError).toBe('runtime start failed');
    expect(toast).toHaveBeenCalledWith({
      title: 'Failed to start worker',
      description: 'runtime start failed',
      variant: 'destructive',
    });
  });

  it('stops the controller runtime and clears queue-active state', async () => {
    const mockController = createMockController(createStatus('running', { active: true }));

    const { result } = renderHook(() =>
      useEmbeddingWorkerControls({
        controller: mockController.controller,
        activeEmbeddingSetId: 'set-1',
        onBackfill: vi.fn(async () => {}),
        toast,
      })
    );

    await act(async () => {
      await result.current.stopWorker();
    });

    expect(mockController.stopMock).toHaveBeenCalledTimes(1);
    expect(result.current.workerLocalRunning).toBe(false);
    expect(useVectorStatusUIStore.getState().isEmbeddingQueueActive).toBe(false);
    expect(toast).toHaveBeenCalledWith({ title: 'Worker stopped' });
  });

  it('surfaces controller stop failures consistently', async () => {
    const mockController = createMockController(createStatus('running', { active: true }));
    mockController.stopMock.mockRejectedValueOnce(new Error('stop failed'));

    const { result } = renderHook(() =>
      useEmbeddingWorkerControls({
        controller: mockController.controller,
        activeEmbeddingSetId: 'set-1',
        onBackfill: vi.fn(async () => {}),
        toast,
      })
    );

    await act(async () => {
      await result.current.stopWorker();
    });

    expect(result.current.startWorkerError).toBe('stop failed');
    expect(toast).toHaveBeenCalledWith({
      title: 'Failed to stop worker',
      description: 'stop failed',
      variant: 'destructive',
    });
  });

  it('resets the controller runtime and reports reset errors strictly', async () => {
    const mockController = createMockController(createStatus('running'));
    mockController.resetMock.mockResolvedValueOnce(
      createStatus('error', { lastError: 'reset failed' })
    );

    const { result } = renderHook(() =>
      useEmbeddingWorkerControls({
        controller: mockController.controller,
        activeEmbeddingSetId: 'set-1',
        onBackfill: vi.fn(async () => {}),
        toast,
      })
    );

    await act(async () => {
      await result.current.resetWorker();
    });

    expect(result.current.startWorkerError).toBe('reset failed');
    expect(toast).toHaveBeenCalledWith({
      title: 'Worker reset failed',
      description: 'reset failed',
      variant: 'destructive',
    });
  });
});
