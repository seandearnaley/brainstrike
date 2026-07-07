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
  detectDeviceCapabilitiesMock,
  ensureVectorPreferencesHydratedMock,
  generateQueryEmbeddingMock,
  initializeWithModelMock,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  setDetectedDevicePrefMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
} = vi.hoisted(() => ({
  commandListenerRef: {
    current: null as null | ((command: unknown) => void),
  },
  createEmbeddingCacheRepositoryMock: vi.fn(),
  currentDbRef: {
    current: null as null | { query: ReturnType<typeof vi.fn> },
  },
  dbHandle: { query: vi.fn() },
  detectDeviceCapabilitiesMock: vi.fn(),
  embeddingCacheRepository: {
    get: vi.fn(),
    getBatch: vi.fn(),
    set: vi.fn(),
    setBatch: vi.fn(),
  },
  embeddingQueueBootstrapMock: vi.fn(),
  ensureVectorPreferencesHydratedMock: vi.fn(),
  generateQueryEmbeddingMock: vi.fn(async () => ({
    embedding: [0.1, 0.2],
    runtime: {
      device: 'webgpu',
      dtype: 'fp32',
      fallbackApplied: false,
    },
  })),
  getEmbeddingQueueMock: vi.fn(() => ({ id: 'embedding-queue' })),
  initializeWithModelMock: vi.fn(async () => {}),
  queryEmbeddingListenerRef: {
    current: null as null | ((request: unknown) => void),
  },
  reportQueryEmbeddingResponseMock: vi.fn(),
  reportStatusMock: vi.fn(),
  setDetectedDevicePrefMock: vi.fn(),
  startEmbeddingWorkerMock: vi.fn(),
  stopMock: vi.fn(),
  storeState: {
    devicePref: 'webgpu' as 'wasm' | 'webgpu',
    devicePrefConfigured: true,
    hasHydrated: false,
    reinitEveryN: 200,
    setDetectedDevicePref: vi.fn((devicePref: 'wasm' | 'webgpu') => {
      storeState.devicePref = devicePref;
      setDetectedDevicePrefMock(devicePref);
    }),
  },
}));

vi.mock('@brainstrike/db', () => ({
  createEmbeddingCacheRepository: createEmbeddingCacheRepositoryMock,
  usePGliteDatabase: () => currentDbRef.current,
}));

vi.mock('@brainstrike/preferences/stores/vector-preferences-store', () => ({
  ensureVectorPreferencesHydrated: ensureVectorPreferencesHydratedMock,
  useVectorPreferencesStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    {
      getState: () => storeState,
    }
  ),
}));

vi.mock('@brainstrike/embeddings', () => ({
  detectDeviceCapabilities: detectDeviceCapabilitiesMock,
}));

vi.mock('@brainstrike/embeddings/worker', () => ({
  createForegroundEmbeddingGate: () => ({
    begin: () => {},
    end: () => {},
    isActive: () => false,
    waitUntilInactive: async () => {},
  }),
  POWER_BROADCAST_CHANNEL: 'brainstrike-test-power',
  runCoordinatedQueryEmbedding: async (options: { generate: () => Promise<unknown> }) =>
    options.generate(),
  startEmbeddingWorker: startEmbeddingWorkerMock,
}));

vi.mock('@brainstrike/embeddings/service', () => ({
  SimpleEmbeddingService: class {
    initializeWithModel = initializeWithModelMock;
    generateQueryEmbedding = generateQueryEmbeddingMock;
    dispose = vi.fn(async () => {});
  },
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
    storeState.devicePrefConfigured = true;
    storeState.reinitEveryN = 200;
    setDetectedDevicePrefMock.mockClear();
    detectDeviceCapabilitiesMock.mockResolvedValue({
      detectedAt: 1,
      recommendationReason: 'test default',
      recommendedDevice: 'webgpu',
      wasmAvailable: true,
      webgpuAdapterAvailable: true,
      webgpuAdapterInfo: null,
      webgpuApiPresent: true,
      webgpuUnavailableReason: null,
      webWorkersAvailable: true,
    });
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

  it('rejects automatic WASM detection when vector preference is not user-configured', async () => {
    storeState.hasHydrated = true;
    storeState.devicePref = 'webgpu';
    storeState.devicePrefConfigured = false;
    detectDeviceCapabilitiesMock.mockResolvedValueOnce({
      detectedAt: 1,
      recommendationReason: 'WASM fallback (WebGPU not available)',
      recommendedDevice: 'wasm',
      wasmAvailable: true,
      webgpuAdapterAvailable: false,
      webgpuAdapterInfo: null,
      webgpuApiPresent: false,
      webgpuUnavailableReason: 'WebGPU API not available in this browser',
      webWorkersAvailable: true,
    });

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          lastError: expect.stringContaining('WebGPU'),
          state: 'error',
        })
      );
    });
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        device: 'wasm',
      })
    );
    expect(setDetectedDevicePrefMock).not.toHaveBeenCalledWith('wasm');
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

  it('passes the hydrated reinit cadence to the background worker', async () => {
    storeState.hasHydrated = true;
    storeState.reinitEveryN = 37;

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          device: 'webgpu',
          reinitEveryN: 37,
        })
      );
    });
  });

  it('reports an error status when actual worker backend differs from the selected preference', async () => {
    storeState.hasHydrated = true;
    startEmbeddingWorkerMock.mockImplementationOnce(async (options) => {
      options.onRuntimeMetadataChange?.({
        device: 'wasm',
        dtype: 'q8',
        fallbackApplied: true,
      });
      return {
        stop: stopMock,
      };
    });

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.objectContaining({
            actualWorkerMetadata: expect.objectContaining({
              device: 'wasm',
              fallbackApplied: true,
            }),
            backendMismatch: true,
            selectedDevicePreference: 'webgpu',
          }),
          lastError: expect.stringContaining('backend'),
          state: 'error',
        })
      );
    });
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

  it('restarts the WebGPU background worker after a fatal device-loss execution error', async () => {
    storeState.hasHydrated = true;

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    });

    const firstWorkerOptions = startEmbeddingWorkerMock.mock.calls[0]?.[0] as
      | { device?: string; onFatalError?: (error: Error) => void }
      | undefined;
    if (!firstWorkerOptions?.onFatalError) {
      throw new Error('Expected embedding worker start options to include onFatalError.');
    }

    firstWorkerOptions.onFatalError(
      new Error(
        "Local embedding execution failed for 'local::Xenova/all-MiniLM-L6-v2': Embedding worker runtime error: WebGPU device lost: device was lost"
      )
    );

    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2);
    });

    const secondWorkerOptions = startEmbeddingWorkerMock.mock.calls[1]?.[0] as
      | { device?: string }
      | undefined;
    expect(secondWorkerOptions?.device).toBe('webgpu');
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ device: 'wasm' })
    );
  });

  it('stops automatic WebGPU device-loss restarts after repeated fatal errors', async () => {
    storeState.hasHydrated = true;

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(1);
    });

    const triggerDeviceLoss = async (callIndex: number): Promise<void> => {
      const workerOptions = startEmbeddingWorkerMock.mock.calls[callIndex]?.[0] as
        | { onFatalError?: (error: Error) => void }
        | undefined;
      if (!workerOptions?.onFatalError) {
        throw new Error(`Expected start call ${callIndex} to include onFatalError.`);
      }
      workerOptions.onFatalError(
        new Error(
          "Local embedding execution failed for 'local::Xenova/all-MiniLM-L6-v2': Embedding worker runtime error: WebGPU device lost: device was lost"
        )
      );
      await waitFor(() => {
        expect(stopMock).toHaveBeenCalledTimes(callIndex + 1);
      });
    };

    await triggerDeviceLoss(0);
    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2);
    });
    await triggerDeviceLoss(1);
    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(3);
    });
    await triggerDeviceLoss(2);

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          lastError: expect.stringContaining('repeated WebGPU device loss'),
          state: 'error',
        })
      );
    });
    expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(3);
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ device: 'wasm' })
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
      channel: 'query-embedding',
      payload: {
        dimensions: 2,
        modelId: 'Xenova/all-MiniLM-L6-v2',
        query: 'database config',
      },
      requestId: 'embedding-query:test',
      runtimeId: 'test-runtime',
      type: 'request',
    });

    expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'query-embedding-error',
        payload: expect.objectContaining({
          message: 'Embedding host query embedding payload.modelKey must be a non-empty string.',
        }),
        requestId: 'embedding-query:test',
        runtimeId: 'test-runtime',
        type: 'error',
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

  it('coordinates a valid query embedding request and reports the result', async () => {
    storeState.hasHydrated = true;
    dbHandle.query.mockResolvedValue({
      rows: [
        {
          capabilities: { defaultDimension: 2 },
          description: '',
          id: 'Xenova/all-MiniLM-L6-v2',
          name: 'MiniLM',
          parameters: {},
          providerId: 'local',
        },
      ],
    });

    render(<EmbeddingHostRuntime />);
    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalled();
    });
    const queryEmbeddingListener = queryEmbeddingListenerRef.current;
    if (!queryEmbeddingListener) {
      throw new Error('Expected embedding host query embedding listener to be registered.');
    }

    queryEmbeddingListener({
      channel: 'query-embedding',
      payload: {
        dimensions: 2,
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local:Xenova/all-MiniLM-L6-v2',
        query: 'database config',
      },
      requestId: 'embedding-query:valid',
      runtimeId: 'test-runtime',
      type: 'request',
    });

    await waitFor(() => {
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'embedding-query:valid',
          runtimeId: 'test-runtime',
        })
      );
    });

    const lastCall = reportQueryEmbeddingResponseMock.mock.calls.at(-1)?.[0] as {
      channel?: string;
      type?: string;
    };
    expect(lastCall?.type).not.toBe('error');
    expect(initializeWithModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: 2,
        id: 'Xenova/all-MiniLM-L6-v2',
        name: 'MiniLM',
        origin: 'local',
        tags: ['local', 'embedding'],
      }),
      undefined,
      'webgpu'
    );
    expect(ensureVectorPreferencesHydratedMock).toHaveBeenCalledWith({ forceReload: true });
    expect(reportStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingRuntime: expect.objectContaining({
          actualWorkerMetadata: {
            device: 'webgpu',
            dtype: 'fp32',
            fallbackApplied: false,
          },
          backendMismatch: false,
          selectedDevicePreference: 'webgpu',
        }),
      })
    );
  });
});
