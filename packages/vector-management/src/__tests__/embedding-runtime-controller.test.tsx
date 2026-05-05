import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmbeddingRuntimeController } from '../vector-status/embedding-runtime-controller';

const {
  backgroundDbState,
  createPriorityDbHandleMock,
  getRegisteredEmbeddingRuntimeConfigMock,
  startEmbeddingWorkerMock,
} = vi.hoisted(() => ({
  backgroundDbState: {
    current: { query: vi.fn(async () => ({ rows: [] })) },
  },
  createPriorityDbHandleMock: vi.fn(() => backgroundDbState.current),
  getRegisteredEmbeddingRuntimeConfigMock: vi.fn(),
  startEmbeddingWorkerMock: vi.fn(),
}));

const {
  cancelBackfillMock,
  cancelAllBackfillsMock,
  enqueueBackfillMock,
  ensureStartedMock,
  getStatusMock,
  onStatusMock,
  stopMock,
} = vi.hoisted(() => ({
  cancelBackfillMock: vi.fn(async () => {}),
  cancelAllBackfillsMock: vi.fn(async () => {}),
  enqueueBackfillMock: vi.fn(async () => ({ requestId: 'embedding-backfill:test' })),
  ensureStartedMock: vi.fn(),
  getStatusMock: vi.fn(),
  onStatusMock: vi.fn(() => () => {}),
  stopMock: vi.fn(),
}));

vi.mock('@brainstrike/embeddings/runtime-config', () => ({
  getRegisteredEmbeddingRuntimeConfig: getRegisteredEmbeddingRuntimeConfigMock,
}));

vi.mock('@brainstrike/embeddings/worker', () => ({
  startEmbeddingWorker: startEmbeddingWorkerMock,
}));

vi.mock('@brainstrike/db', () => ({
  createPriorityDbHandle: createPriorityDbHandleMock,
}));

describe('useEmbeddingRuntimeController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startEmbeddingWorkerMock.mockResolvedValue({ stop: vi.fn(async () => {}) });
    getRegisteredEmbeddingRuntimeConfigMock.mockReturnValue({
      streamingWorkerUrl: '/worker/embedding.worker.js',
    });

    const runningStatus = {
      runtimeKind: 'embedding-host' as const,
      runtimeId: 'embedding-host:test-runtime',
      state: 'running' as const,
      active: false,
      lastError: null,
    };

    getStatusMock.mockResolvedValue(runningStatus);
    ensureStartedMock.mockResolvedValue(runningStatus);
    stopMock.mockResolvedValue({
      ...runningStatus,
      state: 'stopped' as const,
    });

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {},
    });

    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: {
        cancelBackfill: cancelBackfillMock,
        cancelAllBackfills: cancelAllBackfillsMock,
        enqueueBackfill: enqueueBackfillMock,
        ensureStarted: ensureStartedMock,
        getBackfillsInFlight: vi.fn(async () => []),
        getStatus: getStatusMock,
        onStatus: onStatusMock,
        reset: vi.fn(),
        stop: stopMock,
      },
    });
  });

  function clearDesktopHostBridge(): void {
    Reflect.deleteProperty(window, 'electronAPI');
    Reflect.deleteProperty(window, 'embeddingHost');
  }

  it('starts the desktop host without resetting it before desktop backfill', async () => {
    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await act(async () => {
      await result.current.enqueueBackfill('set-1');
    });

    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(stopMock).not.toHaveBeenCalled();
    expect(ensureStartedMock).toHaveBeenCalledTimes(1);
    expect(enqueueBackfillMock).toHaveBeenCalledWith({
      embeddingSetId: 'set-1',
      source: 'manual',
    });
  });

  it('forwards desktop backfill cancellation requests through the host bridge', async () => {
    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await act(async () => {
      await result.current.cancelAllBackfills();
    });

    expect(cancelAllBackfillsMock).toHaveBeenCalledTimes(1);
  });

  it('forwards per-collection desktop backfill cancellation requests through the host bridge', async () => {
    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await act(async () => {
      await result.current.cancelBackfill('set-1');
    });

    expect(cancelBackfillMock).toHaveBeenCalledWith('set-1');
  });

  it('returns structured in-flight desktop backfill metadata', async () => {
    const inFlightMock = vi.fn(async () => [
      {
        embeddingSetId: 'set-1',
        requestId: 'background-indexing-backfill:test',
        progress: { current: 2, total: 4 },
      },
    ]);
    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: {
        cancelBackfill: cancelBackfillMock,
        cancelAllBackfills: cancelAllBackfillsMock,
        enqueueBackfill: enqueueBackfillMock,
        ensureStarted: ensureStartedMock,
        getBackfillsInFlight: inFlightMock,
        getStatus: getStatusMock,
        onStatus: onStatusMock,
        reset: vi.fn(),
        stop: stopMock,
      },
    });

    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await expect(result.current.getBackfillsInFlight()).resolves.toEqual([
      {
        embeddingSetId: 'set-1',
        requestId: 'background-indexing-backfill:test',
        progress: { current: 2, total: 4 },
      },
    ]);
  });

  it('does not reset the desktop host across repeated backfills when the settings are unchanged', async () => {
    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await act(async () => {
      await result.current.enqueueBackfill('set-1');
      await result.current.enqueueBackfill('set-2');
    });

    expect(stopMock).not.toHaveBeenCalled();
    expect(ensureStartedMock).toHaveBeenCalledTimes(2);
    expect(enqueueBackfillMock).toHaveBeenNthCalledWith(1, {
      embeddingSetId: 'set-1',
      source: 'manual',
    });
    expect(enqueueBackfillMock).toHaveBeenNthCalledWith(2, {
      embeddingSetId: 'set-2',
      source: 'manual',
    });
  });

  it('does not stop the desktop host when the hook remounts mid-session', async () => {
    const firstRender = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await act(async () => {
      await firstRender.result.current.enqueueBackfill('set-1');
    });

    firstRender.unmount();

    const secondRender = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await act(async () => {
      await secondRender.result.current.enqueueBackfill('set-2');
    });

    expect(stopMock).not.toHaveBeenCalled();
    expect(ensureStartedMock).toHaveBeenCalledTimes(2);
    expect(enqueueBackfillMock).toHaveBeenNthCalledWith(2, {
      embeddingSetId: 'set-2',
      source: 'manual',
    });
  });

  it('does not stop the desktop host automatically when the visible preference changes', async () => {
    const initialProps: { devicePreference: 'wasm' | 'webgpu' } = {
      devicePreference: 'wasm',
    };
    const { result, rerender } = renderHook(
      ({ devicePreference }: { devicePreference: 'wasm' | 'webgpu' }) =>
        useEmbeddingRuntimeController({
          db: null,
          devicePreference,
          reinitEveryN: 200,
          service: null,
        }),
      {
        initialProps,
      }
    );

    await act(async () => {
      await result.current.enqueueBackfill('set-1');
    });

    rerender({ devicePreference: 'webgpu' });

    await act(async () => {
      await result.current.enqueueBackfill('set-2');
    });

    expect(stopMock).not.toHaveBeenCalled();
    expect(ensureStartedMock).toHaveBeenCalledTimes(2);
    expect(enqueueBackfillMock).toHaveBeenNthCalledWith(2, {
      embeddingSetId: 'set-2',
      source: 'manual',
    });
  });

  it('passes the registered streaming worker URL when starting the local web worker', async () => {
    clearDesktopHostBridge();

    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const backgroundDb = { query: vi.fn(async () => ({ rows: [] })) };
    backgroundDbState.current = backgroundDb;
    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await act(async () => {
      await result.current.start();
    });

    expect(startEmbeddingWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        db: backgroundDb,
        device: 'wasm',
        enable: true,
        reinitEveryN: 200,
        streamingWorkerUrl: '/worker/embedding.worker.js',
      })
    );
    expect(createPriorityDbHandleMock).toHaveBeenCalledWith(db, 'background');
  });

  it('fails fast when local web worker runtime config is not registered', async () => {
    clearDesktopHostBridge();
    getRegisteredEmbeddingRuntimeConfigMock.mockReturnValue(null);

    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: null,
      })
    );

    await expect(act(async () => await result.current.start())).rejects.toThrow(
      'Embedding runtime config is not registered'
    );
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
  });

  it('tracks and cancels local backfills per embedding set', async () => {
    clearDesktopHostBridge();

    const backfillMock = vi.fn(
      async (
        _embeddingSetId: string,
        options: {
          onProgress: (done: number, total: number) => void;
          signal?: AbortSignal;
        }
      ) =>
        await new Promise<void>((resolve, reject) => {
          options.onProgress(1, 3);
          options.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
          // Keep pending until canceled.
          void resolve;
        })
    );

    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: {
          backfill: backfillMock,
        } as never,
      })
    );

    let pendingBackfill: Promise<{ requestId: string }> | null = null;
    await act(async () => {
      const startedBackfill = result.current.enqueueBackfill('set-1', {
        source: 'background-indexing',
      });
      void startedBackfill.catch(() => {});
      pendingBackfill = startedBackfill;
      await Promise.resolve();
    });

    await expect(result.current.getBackfillsInFlight()).resolves.toEqual([
      expect.objectContaining({
        embeddingSetId: 'set-1',
        progress: { current: 1, total: 3 },
        requestId: expect.stringContaining('background-indexing-backfill'),
      }),
    ]);

    await act(async () => {
      await result.current.cancelBackfill('set-1');
    });

    await expect(pendingBackfill).rejects.toMatchObject({ name: 'AbortError' });
    expect(backfillMock).toHaveBeenCalledWith(
      'set-1',
      expect.objectContaining({
        onProgress: expect.any(Function),
        queueCapacityTimeoutMs: 600_000,
        signal: expect.any(AbortSignal),
      })
    );
    await expect(result.current.getBackfillsInFlight()).resolves.toEqual([]);
  });

  it('cancels all local backfills and emits local backfill progress events', async () => {
    clearDesktopHostBridge();

    const backfillMock = vi.fn(
      async (
        embeddingSetId: string,
        options: {
          onProgress: (done: number, total: number) => void;
          signal?: AbortSignal;
        }
      ) =>
        await new Promise<void>((resolve, reject) => {
          options.onProgress(2, embeddingSetId === 'set-1' ? 4 : 6);
          options.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error(`aborted:${embeddingSetId}`);
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
          void resolve;
        })
    );

    const { result } = renderHook(() =>
      useEmbeddingRuntimeController({
        db: null,
        devicePreference: 'wasm',
        reinitEveryN: 200,
        service: {
          backfill: backfillMock,
        } as never,
      })
    );

    const progressListener = vi.fn();
    const unsubscribe = result.current.onBackfillProgress(progressListener);

    let pendingOne: Promise<{ requestId: string }> | null = null;
    let pendingTwo: Promise<{ requestId: string }> | null = null;
    await act(async () => {
      const startedOne = result.current.enqueueBackfill('set-1');
      const startedTwo = result.current.enqueueBackfill('set-2');
      void startedOne.catch(() => {});
      void startedTwo.catch(() => {});
      pendingOne = startedOne;
      pendingTwo = startedTwo;
      await Promise.resolve();
    });

    expect(progressListener).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingSetId: 'set-1',
        current: 2,
        total: 4,
      })
    );
    expect(progressListener).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingSetId: 'set-2',
        current: 2,
        total: 6,
      })
    );

    await act(async () => {
      await result.current.cancelAllBackfills();
    });

    await expect(pendingOne).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pendingTwo).rejects.toMatchObject({ name: 'AbortError' });
    unsubscribe();
  });
});
