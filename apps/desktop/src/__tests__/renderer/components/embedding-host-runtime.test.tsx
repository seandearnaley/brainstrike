import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddingHostCommand } from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';

const {
  commandListenerRef,
  currentDbRef,
  dbHandle,
  embeddingCacheRepository,
  embeddingQueueBootstrapMock,
  getEmbeddingQueueMock,
  createEmbeddingCacheRepositoryMock,
  ensureVectorPreferencesHydratedMock,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
} = vi.hoisted(() => ({
  commandListenerRef: {
    current: null as null | ((command: unknown) => void),
  },
  currentDbRef: {
    current: null as null | { query: ReturnType<typeof vi.fn> },
  },
  dbHandle: { query: vi.fn() },
  embeddingCacheRepository: {
    get: vi.fn(),
    getBatch: vi.fn(),
    set: vi.fn(),
    setBatch: vi.fn(),
  },
  embeddingQueueBootstrapMock: vi.fn(),
  getEmbeddingQueueMock: vi.fn(() => ({ id: 'embedding-queue' })),
  createEmbeddingCacheRepositoryMock: vi.fn(),
  ensureVectorPreferencesHydratedMock: vi.fn(),
  queryEmbeddingListenerRef: {
    current: null as null | ((request: unknown) => void),
  },
  reportQueryEmbeddingResponseMock: vi.fn(),
  reportStatusMock: vi.fn(),
  startEmbeddingWorkerMock: vi.fn(),
  stopMock: vi.fn(),
  storeState: {
    hasHydrated: false,
    devicePref: 'webgpu' as 'wasm' | 'webgpu',
  },
}));

vi.mock('@brainstrike/db', () => ({
  createEmbeddingCacheRepository: createEmbeddingCacheRepositoryMock,
  usePGliteDatabase: () => currentDbRef.current,
}));

vi.mock('@brainstrike/preferences/stores/vector-preferences-store', () => ({
  ensureVectorPreferencesHydrated: ensureVectorPreferencesHydratedMock,
  useVectorPreferencesStore: (selector: (state: typeof storeState) => unknown) =>
    selector(storeState),
}));

vi.mock('@brainstrike/embeddings/worker', () => ({
  POWER_BROADCAST_CHANNEL: 'brainstrike-test-power',
  startEmbeddingWorker: startEmbeddingWorkerMock,
}));

vi.mock('../../../renderer/create-embedding-queue', () => ({
  ...(() => {
    embeddingQueueBootstrapMock();
    return {
      getEmbeddingQueue: getEmbeddingQueueMock,
    };
  })(),
}));

vi.mock('../../../renderer/components/embedding-worker-config', () => ({
  createEmbeddingWorkerConfig: () => ({
    db: dbHandle,
  }),
}));

describe('EmbeddingHostRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentDbRef.current = dbHandle;
    storeState.hasHydrated = false;
    storeState.devicePref = 'webgpu';
    ensureVectorPreferencesHydratedMock.mockImplementation(async () => {
      if (!storeState.hasHydrated) {
        throw new Error('Vector preferences store failed to hydrate.');
      }
      return storeState;
    });
    createEmbeddingCacheRepositoryMock.mockReturnValue(embeddingCacheRepository);
    startEmbeddingWorkerMock.mockResolvedValue({
      stop: stopMock,
    });

    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: {
        onCommand: (callback: (command: unknown) => void) => {
          commandListenerRef.current = callback;
          return () => {
            commandListenerRef.current = null;
          };
        },
        onQueryEmbeddingRequest: (callback: (request: unknown) => void) => {
          queryEmbeddingListenerRef.current = callback;
          return () => {
            queryEmbeddingListenerRef.current = null;
          };
        },
        reportQueryEmbeddingResponse: reportQueryEmbeddingResponseMock,
        reportStatus: reportStatusMock,
      },
    });

    Object.defineProperty(window, 'power', {
      configurable: true,
      value: {
        onPowerState: () => () => {},
      },
    });

    window.history.replaceState({}, '', '/?mode=embedding-host&runtimeId=test-runtime');
  });

  it('waits for vector preference hydration before starting the worker', async () => {
    let resolveHydration: ((value: typeof storeState) => void) | null = null;
    ensureVectorPreferencesHydratedMock.mockImplementation(
      () =>
        new Promise<typeof storeState>((resolve) => {
          resolveHydration = resolve;
        })
    );

    render(<EmbeddingHostRuntime />);

    expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(ensureVectorPreferencesHydratedMock).toHaveBeenCalled();
    });

    storeState.hasHydrated = true;
    storeState.devicePref = 'wasm';
    resolveHydration?.(storeState);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          device: 'wasm',
          initializeLocalModelOnStart: false,
        })
      );
    });
    expect(embeddingQueueBootstrapMock).toHaveBeenCalledTimes(1);
    expect(getEmbeddingQueueMock).toHaveBeenCalledTimes(1);
  });

  it('passes an embedding cache repository to the worker', async () => {
    storeState.hasHydrated = true;

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          db: dbHandle,
          embeddingCache: embeddingCacheRepository,
        })
      );
    });
    expect(createEmbeddingCacheRepositoryMock).toHaveBeenCalledWith(dbHandle);
  });

  it('resets the worker when it receives a strict reset command envelope', async () => {
    storeState.hasHydrated = true;

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalled();
    });
    const initialStartCount = startEmbeddingWorkerMock.mock.calls.length;

    const commandListener = commandListenerRef.current;
    if (!commandListener) {
      throw new Error('Expected embedding host command listener to be registered.');
    }

    commandListener(
      createEmbeddingHostCommand('reset', 'test-runtime', 'embedding-host:next-runtime')
    );

    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(initialStartCount + 1);
    });
    expect(reportStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: 'embedding-host:next-runtime',
        state: 'running',
      })
    );
  });

  it('reports invalid query embedding request envelopes back to main promptly', async () => {
    storeState.hasHydrated = true;

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalled();
    });
    const queryEmbeddingListener = queryEmbeddingListenerRef.current;
    if (!queryEmbeddingListener) {
      throw new Error('Expected embedding host query embedding listener to be registered.');
    }

    queryEmbeddingListener({
      type: 'request',
      channel: 'query-embedding',
      requestId: 'embedding-query:test',
      runtimeId: 'test-runtime',
      payload: {
        dimensions: 2,
        modelId: 'Xenova/all-MiniLM-L6-v2',
        query: 'database config',
      },
    });

    expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        channel: 'query-embedding-error',
        requestId: 'embedding-query:test',
        runtimeId: 'test-runtime',
        payload: expect.objectContaining({
          message: 'Embedding host query embedding payload.modelKey must be a non-empty string.',
        }),
      })
    );
  });

  it('does not report stopped status again after unmount cleanup finishes', async () => {
    storeState.hasHydrated = true;
    let resolveStop: (() => void) | null = null;
    stopMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        })
    );

    const view = render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    });

    view.unmount();
    resolveStop?.();
    await Promise.resolve();

    const stoppedReports = reportStatusMock.mock.calls.filter(
      ([status]) => (status as { state?: string }).state === 'stopped'
    );
    expect(stoppedReports).toHaveLength(0);
  });

  it('waits for an in-flight stop before restarting on db changes', async () => {
    storeState.hasHydrated = true;
    const nextDbHandle = { query: vi.fn() };
    let resolveStop: (() => void) | null = null;
    stopMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        })
    );

    const view = render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    });

    currentDbRef.current = nextDbHandle;
    view.rerender(<EmbeddingHostRuntime />);

    expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);

    resolveStop?.();

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2);
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup if bridge teardown callbacks throw', async () => {
    storeState.hasHydrated = true;
    stopMock.mockResolvedValue(undefined);

    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: {
        onCommand: () => () => {
          throw new Error('command cleanup failed');
        },
        reportStatus: reportStatusMock,
      },
    });

    Object.defineProperty(window, 'power', {
      configurable: true,
      value: {
        onPowerState: () => () => {
          throw new Error('power cleanup failed');
        },
      },
    });

    const closeSpy = vi.spyOn(BroadcastChannel.prototype, 'close').mockImplementation(() => {
      throw new Error('channel close failed');
    });

    const view = render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    });

    expect(() => view.unmount()).not.toThrow();

    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledTimes(1);
    });

    closeSpy.mockRestore();
  });
});
