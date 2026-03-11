import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmbeddingRuntimeController } from '../vector-status/embedding-runtime-controller';

const { getRegisteredEmbeddingRuntimeConfigMock, startEmbeddingWorkerMock } = vi.hoisted(() => ({
  getRegisteredEmbeddingRuntimeConfigMock: vi.fn(),
  startEmbeddingWorkerMock: vi.fn(),
}));

const { enqueueBackfillMock, ensureStartedMock, getStatusMock, onStatusMock, stopMock } =
  vi.hoisted(() => ({
    enqueueBackfillMock: vi.fn(),
    ensureStartedMock: vi.fn(),
    getStatusMock: vi.fn(),
    onStatusMock: vi.fn(() => () => {}),
    stopMock: vi.fn(),
  }));

vi.mock('@brainstrike/embeddings', () => ({
  getRegisteredEmbeddingRuntimeConfig: getRegisteredEmbeddingRuntimeConfigMock,
  startEmbeddingWorker: startEmbeddingWorkerMock,
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
        enqueueBackfill: enqueueBackfillMock,
        ensureStarted: ensureStartedMock,
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

  it('resets the desktop host before backfill when runtime settings have not been synced', async () => {
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

    expect(getStatusMock).toHaveBeenCalled();
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(ensureStartedMock).toHaveBeenCalledTimes(1);
    expect(enqueueBackfillMock).toHaveBeenCalledWith('set-1');
  });

  it('does not keep resetting the desktop host when the settings are unchanged', async () => {
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

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(ensureStartedMock).toHaveBeenCalledTimes(2);
    expect(enqueueBackfillMock).toHaveBeenNthCalledWith(1, 'set-1');
    expect(enqueueBackfillMock).toHaveBeenNthCalledWith(2, 'set-2');
  });

  it('resets the desktop host again when the desired device preference changes', async () => {
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

    expect(stopMock).toHaveBeenCalledTimes(2);
    expect(ensureStartedMock).toHaveBeenCalledTimes(2);
    expect(enqueueBackfillMock).toHaveBeenNthCalledWith(2, 'set-2');
  });

  it('passes the registered streaming worker URL when starting the local web worker', async () => {
    clearDesktopHostBridge();

    const db = { query: vi.fn(async () => ({ rows: [] })) };
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
        db,
        device: 'wasm',
        enable: true,
        reinitEveryN: 200,
        streamingWorkerUrl: '/worker/embedding.worker.js',
      })
    );
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
});
