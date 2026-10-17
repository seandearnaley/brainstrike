// @vitest-environment jsdom
import './embedding-host-runtime-fixture';
import {
  recordEmbeddingBatchTelemetry,
  recordEmbeddingTelemetryFailure,
} from '@brainstrike/embedding-worker';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingHostCommand } from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  commandListenerRef,
  createEmbeddingCacheRepositoryMock,
  detectDeviceCapabilitiesMock,
  disposeQueryEmbeddingServiceMock,
  ensureVectorPreferencesHydratedMock,
  generateQueryEmbeddingMock,
  getEmbeddingQueueMock,
  initializeMock,
  initializeWithModelMock,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingListenerRef,
  readModelCatalogMock,
  reopenEmbeddingQueueMock,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  retireEmbeddingQueueMock,
  setDetectedDevicePrefMock,
  startEmbeddingWorkerMock,
  storeState,
} from './embedding-host-runtime-fixture';

function installCatalog(): void {
  readModelCatalogMock.mockResolvedValue({
    models: [
      {
        capabilities: { defaultDimension: 2 },
        description: '',
        id: 'Xenova/all-MiniLM-L6-v2',
        name: 'MiniLM',
        parameters: {},
        providerId: 'local',
      },
    ],
    providers: [],
  });
}
function catalogRequest(requestId: string): unknown {
  return {
    channel: 'query-embedding',
    payload: {
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local:Xenova/all-MiniLM-L6-v2',
      query: 'fixture query',
    },
    requestId,
    runtimeId: 'test-runtime',
    type: 'request',
  };
}
async function mountReady(): Promise<void> {
  render(<EmbeddingHostRuntime />);
  await waitFor(() =>
    expect(reportStatusMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'running' }))
  );
}
async function warmNativeRuntime(): Promise<void> {
  installCatalog();
  storeState.hasHydrated = true;
  await mountReady();
  queryEmbeddingListenerRef.current?.(catalogRequest('warm-telemetry'));
  await waitFor(() =>
    expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'warm-telemetry', type: 'result' })
    )
  );
  reportQueryEmbeddingResponseMock.mockClear();
}

describe('EmbeddingHostRuntime', () => {
  installEmbeddingHostRuntimeFixture();

  it('starts request readiness without resolving preferences or loading a model', async () => {
    render(<EmbeddingHostRuntime />);
    await waitFor(() => expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce());
    expect(ensureVectorPreferencesHydratedMock).not.toHaveBeenCalled();
    expect(initializeWithModelMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
    expect(getEmbeddingQueueMock).toHaveBeenCalledOnce();
  });

  it('rejects automatic WASM detection for an unconfigured unpinned request', async () => {
    storeState.hasHydrated = true;
    storeState.devicePrefConfigured = false;
    detectDeviceCapabilitiesMock.mockResolvedValueOnce({
      recommendedDevice: 'wasm',
      webgpuAdapterAvailable: false,
      webgpuApiPresent: false,
      webWorkersAvailable: true,
    });
    installCatalog();
    await mountReady();
    queryEmbeddingListenerRef.current?.(catalogRequest('unconfigured'));
    await waitFor(() =>
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      )
    );
    expect(initializeWithModelMock).not.toHaveBeenCalled();
    expect(setDetectedDevicePrefMock).not.toHaveBeenCalledWith('wasm');
  });

  it('never constructs a PGlite embedding cache for native readiness', async () => {
    await mountReady();
    expect(createEmbeddingCacheRepositoryMock).not.toHaveBeenCalled();
    expect(readModelCatalogMock).not.toHaveBeenCalled();
  });

  it('refuses the retired background command without creating a database worker', async () => {
    await mountReady();
    const command = createEmbeddingHostCommand('start-background', 'test-runtime');
    await act(async () => commandListenerRef.current?.(command));
    await waitFor(() =>
      expect(reportStatusMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ commandId: command.requestId, state: 'error' })
      )
    );
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
    expect(readModelCatalogMock).not.toHaveBeenCalled();
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
  });

  it.each([
    { device: 'wasm', fallbackApplied: true },
    { device: 'wasm', fallbackApplied: false },
    { device: 'webgpu', fallbackApplied: true },
  ])(
    'refuses actual native backend mismatch %j without relabeling the selection',
    async (actual) => {
      installCatalog();
      storeState.hasHydrated = true;
      generateQueryEmbeddingMock.mockResolvedValueOnce({
        embedding: [0.1, 0.2],
        runtime: { ...actual, dtype: 'q8' },
      });
      await mountReady();
      queryEmbeddingListenerRef.current?.(catalogRequest('backend-mismatch'));
      await waitFor(() =>
        expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: 'backend-mismatch', type: 'error' })
        )
      );
      expect(reportQueryEmbeddingResponseMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'result' })
      );
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.objectContaining({
            actualWorkerMetadata: expect.objectContaining(actual),
            backendMismatch: true,
            selectedDevicePreference: 'webgpu',
          }),
          state: 'error',
        })
      );
    }
  );

  it('coalesces embedding telemetry updates before reporting them to main', async () => {
    storeState.hasHydrated = true;

    await warmNativeRuntime();

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.any(Object),
          state: 'running',
        })
      );
    });
    reportStatusMock.mockClear();

    for (let batchIndex = 0; batchIndex < 2; batchIndex += 1) {
      recordEmbeddingBatchTelemetry('test-worker', {
        batchIndex,
        endIndex: batchIndex + 1,
        id: 'embed-test',
        peakVectorsInFlight: 1,
        startIndex: batchIndex,
        transferBytes: 8,
        type: 'batch',
        vectors: [new Float32Array(2)],
        vectorsInFlight: 1,
      });
    }

    expect(reportStatusMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledTimes(1);
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.objectContaining({
            telemetry: expect.objectContaining({
              batchTransfer: expect.objectContaining({
                batchCount: 2,
                totalBytes: 16,
              }),
            }),
          }),
        })
      );
    });
  });

  it('does not let a pending telemetry report revive a stopped host', async () => {
    storeState.hasHydrated = true;

    await warmNativeRuntime();

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'running' }));
    });
    reportStatusMock.mockClear();

    act(() => {
      recordEmbeddingTelemetryFailure('workerpool telemetry diagnostic missing');
      recordEmbeddingBatchTelemetry('test-worker', {
        batchIndex: 0,
        endIndex: 1,
        id: 'embed-test',
        peakVectorsInFlight: 1,
        startIndex: 0,
        transferBytes: 8,
        type: 'batch',
        vectors: [new Float32Array(2)],
        vectorsInFlight: 1,
      });
      commandListenerRef.current?.(createEmbeddingHostCommand('stop', 'test-runtime'));
    });

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.objectContaining({
            telemetry: expect.objectContaining({
              health: {
                failureCount: 1,
                lastFailure: 'workerpool telemetry diagnostic missing',
              },
            }),
          }),
          state: 'stopped',
        })
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reportStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'stopped' })
    );
  });

  it('resets the worker when it receives a strict reset command envelope', async () => {
    storeState.hasHydrated = true;

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(reopenEmbeddingQueueMock).toHaveBeenCalled();
    });
    const initialStartCount = reopenEmbeddingQueueMock.mock.calls.length;

    const commandListener = commandListenerRef.current;
    if (!commandListener) {
      throw new Error('Expected embedding host command listener to be registered.');
    }

    commandListener(
      createEmbeddingHostCommand('reset', 'test-runtime', 'embedding-host:next-runtime')
    );

    await waitFor(() => {
      expect(retireEmbeddingQueueMock).toHaveBeenCalledTimes(1);
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(initialStartCount + 1);
    });
    expect(reportStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: 'embedding-host:next-runtime',
        state: 'running',
      })
    );
  });

  it('re-resolves only the host device on resolve-device; the worker keeps its device', async () => {
    storeState.hasHydrated = true;
    await warmNativeRuntime();
    await waitFor(() =>
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.objectContaining({
            actualWorkerMetadata: expect.objectContaining({ device: 'webgpu' }),
            selectedDevicePreference: 'webgpu',
          }),
          state: 'running',
        })
      )
    );
    const commandListener = commandListenerRef.current;
    if (!commandListener) {
      throw new Error('Expected embedding host command listener to be registered.');
    }
    // The user picks WASM in the vector preferences; Main relays the change.
    storeState.devicePref = 'wasm';
    commandListener(createEmbeddingHostCommand('resolve-device', 'test-runtime'));
    await waitFor(() =>
      expect(reportStatusMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.objectContaining({ hostDevice: 'wasm' }),
          state: 'running',
        })
      )
    );
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
    expect(initializeWithModelMock).toHaveBeenCalledOnce();
    expect(retireEmbeddingQueueMock).not.toHaveBeenCalled();
    queryEmbeddingListenerRef.current?.(catalogRequest('reuse-after-preference-change'));
    await waitFor(() =>
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'reuse-after-preference-change', type: 'result' })
      )
    );
    expect(reportStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        embeddingRuntime: expect.objectContaining({
          backendMismatch: false,
          hostDevice: 'wasm',
          selectedDevicePreference: 'webgpu',
        }),
      })
    );
    expect(initializeWithModelMock).toHaveBeenCalledOnce();
  });

  it('does not replay or restart native inference after a device loss', async () => {
    installCatalog();
    storeState.hasHydrated = true;
    generateQueryEmbeddingMock.mockRejectedValueOnce(
      Object.assign(new Error('Device lost'), { code: 'EMBEDDING_DEVICE_LOST' })
    );
    await mountReady();
    queryEmbeddingListenerRef.current?.(catalogRequest('lost'));
    await waitFor(() =>
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'EMBEDDING_DEVICE_LOST' }),
          type: 'error',
        })
      )
    );
    expect(generateQueryEmbeddingMock).toHaveBeenCalledOnce();
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
  });

  it('keeps repeated native failures explicit without an automatic retry budget or WASM fallback', async () => {
    installCatalog();
    storeState.hasHydrated = true;
    await mountReady();
    for (let index = 0; index < 3; index += 1) {
      generateQueryEmbeddingMock.mockRejectedValueOnce(
        Object.assign(new Error('Device lost'), { code: 'EMBEDDING_DEVICE_LOST' })
      );
      queryEmbeddingListenerRef.current?.(catalogRequest(`lost-${index}`));
      await waitFor(() =>
        expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(index + 1)
      );
    }
    expect(
      reportQueryEmbeddingResponseMock.mock.calls.every(([report]) => report.type === 'error')
    ).toBe(true);
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(3);
    expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
    expect(initializeWithModelMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'wasm'
    );
    expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
  });

  it('reports invalid query embedding request envelopes back to main promptly', async () => {
    storeState.hasHydrated = true;

    render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(reopenEmbeddingQueueMock).toHaveBeenCalled();
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

  it.each(['started', 'failed'] as const)(
    'joins in-flight startup before acknowledging Stop (%s)',
    async (outcome) => {
      storeState.hasHydrated = true;
      const starting = Promise.withResolvers<void>();
      reopenEmbeddingQueueMock.mockReturnValueOnce(starting.promise);
      const view = render(<EmbeddingHostRuntime />);
      await waitFor(() => expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce());
      reportStatusMock.mockClear();
      const command = createEmbeddingHostCommand('stop', 'test-runtime');
      await act(async () => {
        commandListenerRef.current?.(command);
      });
      expect(reportStatusMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: 'stopped' })
      );
      await act(async () => {
        if (outcome === 'started') {
          starting.resolve();
        } else {
          starting.reject(new Error('Startup device is unavailable'));
        }
      });
      await waitFor(() =>
        expect(reportStatusMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            commandId: command.requestId,
            state: outcome === 'started' ? 'stopped' : 'error',
            ...(outcome === 'failed' ? { lastError: 'Startup device is unavailable' } : {}),
          })
        )
      );
      expect(reportStatusMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: 'running' })
      );
      if (outcome === 'started') {
        expect(reportStatusMock).not.toHaveBeenCalledWith(
          expect.objectContaining({ state: 'error' })
        );
      }
      expect(retireEmbeddingQueueMock).toHaveBeenCalledOnce();
      view.unmount();
    }
  );

  it.each(['stop', 'reset'] as const)(
    'reports a failed %s without starting a replacement worker',
    async (action) => {
      storeState.hasHydrated = true;
      const view = render(<EmbeddingHostRuntime />);
      await waitFor(() => expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce());
      retireEmbeddingQueueMock.mockRejectedValueOnce(new Error('Worker drain failed'));
      const command =
        action === 'stop'
          ? createEmbeddingHostCommand('stop', 'test-runtime')
          : createEmbeddingHostCommand('reset', 'test-runtime', 'replacement-runtime');
      await act(async () => commandListenerRef.current?.(command));
      await waitFor(() =>
        expect(reportStatusMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            commandId: command.requestId,
            lastError: 'Worker drain failed',
            runtimeId: 'test-runtime',
            state: 'error',
          })
        )
      );
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
      view.unmount();
    }
  );

  it('does not report stopped status again after unmount cleanup finishes', async () => {
    storeState.hasHydrated = true;
    let resolveStop: (() => void) | null = null;
    retireEmbeddingQueueMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        })
    );

    const view = render(<EmbeddingHostRuntime />);

    await waitFor(() => {
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    });

    view.unmount();
    await act(async () => {});
    const finishStop = resolveStop as (() => void) | null;
    if (!finishStop) {
      throw new Error('Expected embedding host stop to be pending.');
    }
    finishStop();
    await Promise.resolve();

    const stoppedReports = reportStatusMock.mock.calls.filter(
      ([status]) => (status as { state?: string }).state === 'stopped'
    );
    expect(stoppedReports).toHaveLength(0);
  });

  it.each(['stopped', 'failed'] as const)(
    'joins physical queue retirement before explicit replacement (%s)',
    async (outcome) => {
      storeState.hasHydrated = true;
      const stopping = Promise.withResolvers<void>();
      retireEmbeddingQueueMock.mockReturnValueOnce(stopping.promise);
      const view = render(<EmbeddingHostRuntime />);
      await waitFor(() => expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce());
      reportStatusMock.mockClear();
      commandListenerRef.current?.(
        createEmbeddingHostCommand('reset', 'test-runtime', 'replacement-runtime')
      );
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledOnce();
      await act(async () => {
        if (outcome === 'stopped') {
          stopping.resolve();
        } else {
          stopping.reject(new Error('Old database worker drain failed'));
        }
      });
      await waitFor(() =>
        expect(reportStatusMock).toHaveBeenLastCalledWith(
          expect.objectContaining(
            outcome === 'stopped'
              ? { state: 'running' }
              : { lastError: 'Old database worker drain failed', state: 'error' }
          )
        )
      );
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(outcome === 'stopped' ? 2 : 1);
      view.unmount();
    }
  );

  it('continues cleanup if bridge teardown callbacks throw', async () => {
    storeState.hasHydrated = true;
    retireEmbeddingQueueMock.mockResolvedValue(undefined);

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
      expect(reopenEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    });

    expect(() => view.unmount()).not.toThrow();

    await waitFor(() => {
      expect(retireEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    });

    closeSpy.mockRestore();
  });

  it('coordinates a valid query embedding request and reports the result', async () => {
    storeState.hasHydrated = true;
    readModelCatalogMock.mockResolvedValue({
      models: [
        {
          capabilities: { defaultDimension: 2 },
          description: '',
          id: 'Xenova/all-MiniLM-L6-v2',
          name: 'MiniLM',
          parameters: {},
          providerId: 'local',
        },
      ],
      providers: [],
    });

    render(<EmbeddingHostRuntime />);
    await waitFor(() => {
      expect(reopenEmbeddingQueueMock).toHaveBeenCalled();
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
    expect(readModelCatalogMock).toHaveBeenCalledOnce();
    expect(ensureVectorPreferencesHydratedMock).toHaveBeenCalledWith({ forceReload: true });
    expect(reportStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingRuntime: expect.objectContaining({
          actualWorkerMetadata: {
            device: 'webgpu',
            dtype: 'fp32',
            fallbackApplied: false,
            pooling: 'mean',
          },
          backendMismatch: false,
          selectedDevicePreference: 'webgpu',
        }),
      })
    );
  });

  it('keeps telemetry reports active while a foreground query embedding is running', async () => {
    storeState.hasHydrated = true;
    readModelCatalogMock.mockResolvedValue({
      models: [
        {
          capabilities: { defaultDimension: 2 },
          description: '',
          id: 'Xenova/all-MiniLM-L6-v2',
          name: 'MiniLM',
          parameters: {},
          providerId: 'local',
        },
      ],
      providers: [],
    });
    await warmNativeRuntime();
    generateQueryEmbeddingMock.mockClear();
    let releaseQuery: (() => void) | null = null;
    generateQueryEmbeddingMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      return {
        embedding: [0.1, 0.2],
        runtime: {
          device: 'webgpu',
          dtype: 'fp32',
          fallbackApplied: false,
        },
      };
    });

    await waitFor(() => {
      expect(reopenEmbeddingQueueMock).toHaveBeenCalled();
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
        query: 'long-running query',
      },
      requestId: 'embedding-query:telemetry-active',
      runtimeId: 'test-runtime',
      type: 'request',
    });
    await waitFor(() => {
      expect(generateQueryEmbeddingMock).toHaveBeenCalled();
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({ active: true, state: 'running' })
      );
    });
    reportStatusMock.mockClear();

    act(() => {
      recordEmbeddingBatchTelemetry('foreground-query-worker', {
        batchIndex: 0,
        endIndex: 1,
        id: 'foreground-query-batch',
        peakVectorsInFlight: 1,
        startIndex: 0,
        transferBytes: 8,
        type: 'batch',
        vectors: [new Float32Array(2)],
        vectorsInFlight: 1,
      });
    });

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
          embeddingRuntime: expect.objectContaining({
            telemetry: expect.objectContaining({
              batchTransfer: expect.objectContaining({ batchCount: 1 }),
            }),
          }),
          state: 'running',
        })
      );
    });

    const finishQuery = releaseQuery as (() => void) | null;
    if (!finishQuery) {
      throw new Error('Expected query embedding generation to remain pending.');
    }
    finishQuery();
    await waitFor(() => {
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'embedding-query:telemetry-active' })
      );
    });
  });
});

describe('native pinned hidden renderer query', () => {
  installEmbeddingHostRuntimeFixture();
  const plan = {
    device: 'wasm',
    dimensions: 384,
    dtype: 'q8',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  } as const;
  async function start(): Promise<(request: unknown) => void> {
    storeState.hasHydrated = true;
    render(<EmbeddingHostRuntime />);
    await waitFor(() => expect(reopenEmbeddingQueueMock).toHaveBeenCalled());
    const listener = queryEmbeddingListenerRef.current;
    if (!listener) {
      throw new Error('Missing query listener');
    }
    ensureVectorPreferencesHydratedMock.mockClear();
    return listener;
  }
  function request(
    inferencePlan: typeof plan | (Omit<typeof plan, 'dtype'> & { dtype: 'fp32' }),
    id: string
  ): unknown {
    return {
      channel: 'query-embedding',
      payload: {
        dimensions: 384,
        inferencePlan,
        modelId: plan.modelId,
        modelKey: 'native:minilm',
        query: 'find callers',
      },
      requestId: id,
      runtimeId: 'test-runtime',
      type: 'request',
    };
  }
  function result(dtype = 'q8') {
    return {
      dimensions: plan.dimensions,
      embedding: Array.from({ length: 384 }, () => 0.1),
      model: plan.modelId,
      runtime: {
        device: 'wasm',
        dtype,
        fallbackApplied: false,
        pooling: 'mean',
        revision: plan.revision,
      },
    };
  }
  it('uses exact pins without catalog/preferences reads and caches all plan fields', async () => {
    const listener = await start();
    generateQueryEmbeddingMock.mockResolvedValue(result());
    listener(request(plan, 'pinned-1'));
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(1));
    expect(reportQueryEmbeddingResponseMock.mock.calls[0]?.[0]).toMatchObject({ type: 'result' });
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ...plan,
        modelConfig: expect.objectContaining({ dimensions: 384, id: plan.modelId }),
      })
    );
    expect(initializeWithModelMock).not.toHaveBeenCalled();
    expect(ensureVectorPreferencesHydratedMock).not.toHaveBeenCalled();
    listener(request(plan, 'pinned-2'));
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(2));
    expect(initializeMock).toHaveBeenCalledTimes(1);
    generateQueryEmbeddingMock.mockResolvedValue(result('fp32'));
    listener(request({ ...plan, dtype: 'fp32' }, 'pinned-3'));
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(3));
    expect(initializeMock).toHaveBeenCalledTimes(2);
    expect(disposeQueryEmbeddingServiceMock).toHaveBeenCalledTimes(1);
  });
  it('reports the actual pinned device without resolving a startup preference', async () => {
    const listener = await start();
    generateQueryEmbeddingMock.mockResolvedValue(result());
    listener(request(plan, 'pinned-wasm'));
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(1));
    expect(reportStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        embeddingRuntime: expect.objectContaining({
          actualWorkerMetadata: expect.objectContaining({ device: 'wasm' }),
          selectedDevicePreference: 'wasm',
        }),
      })
    );
  });
  it.each([
    undefined,
    { ...result().runtime, device: 'webgpu' },
    { ...result().runtime, dtype: 'fp32' },
    { ...result().runtime, fallbackApplied: true },
    { ...result().runtime, revision: 'main' },
    { ...result().runtime, pooling: 'cls' },
    { device: 'wasm', dtype: 'q8', fallbackApplied: false },
  ])('rejects absent or mismatched actual worker runtime %j', async (runtime) => {
    const listener = await start();
    generateQueryEmbeddingMock.mockResolvedValue({ ...result(), runtime });
    listener(request(plan, 'bad-runtime'));
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(1));
    expect(reportQueryEmbeddingResponseMock.mock.calls[0]?.[0]).toMatchObject({
      payload: { message: expect.stringContaining('pinned') },
      type: 'error',
    });
  });
});
