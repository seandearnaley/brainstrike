import './embedding-host-runtime-fixture';
import {
  recordEmbeddingBatchTelemetry,
  recordEmbeddingTelemetryFailure,
  removeEmbeddingTelemetrySource,
} from '@brainstrike/embedding-worker';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingHostCommand } from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  commandListenerRef,
  createEmbeddingCacheRepositoryMock,
  currentDbRef,
  dbHandle,
  detectDeviceCapabilitiesMock,
  disposeQueryEmbeddingServiceMock,
  embeddingCacheRepository,
  embeddingQueueBootstrapMock,
  ensureVectorPreferencesHydratedMock,
  generateQueryEmbeddingMock,
  getEmbeddingQueueMock,
  initializeMock,
  initializeWithModelMock,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  setDetectedDevicePrefMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
} from './embedding-host-runtime-fixture';

describe('EmbeddingHostRuntime', () => {
  installEmbeddingHostRuntimeFixture();

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
    const finishHydration = resolveHydration as ((value: typeof storeState) => void) | null;
    if (!finishHydration) {
      throw new Error('Expected vector preference hydration to be pending.');
    }
    finishHydration(storeState);

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

  it('coalesces embedding telemetry updates before reporting them to main', async () => {
    storeState.hasHydrated = true;
    startEmbeddingWorkerMock.mockImplementationOnce(async (options) => {
      options.onRuntimeMetadataChange?.({
        device: 'webgpu',
        dtype: 'fp16',
        fallbackApplied: false,
      });
      return {
        stop: stopMock,
      };
    });

    render(<EmbeddingHostRuntime />);

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
    startEmbeddingWorkerMock.mockImplementationOnce(async (options) => {
      options.onRuntimeMetadataChange?.({
        device: 'webgpu',
        dtype: 'fp16',
        fallbackApplied: false,
      });
      return { stop: stopMock };
    });

    render(<EmbeddingHostRuntime />);

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
    stopMock.mockImplementation(async () => {
      removeEmbeddingTelemetrySource('terminal-worker');
    });

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
    act(() => {
      recordEmbeddingBatchTelemetry('terminal-worker', {
        batchIndex: 0,
        endIndex: 1,
        id: 'terminal-worker-batch',
        peakVectorsInFlight: 1,
        startIndex: 0,
        transferBytes: 8,
        type: 'batch',
        vectors: [new Float32Array(2)],
        vectorsInFlight: 1,
      });
    });
    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.objectContaining({
            telemetry: expect.objectContaining({
              batchTransfer: expect.objectContaining({ batchCount: 1 }),
            }),
          }),
        })
      );
    });
    await triggerDeviceLoss(2);

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          embeddingRuntime: expect.objectContaining({
            telemetry: expect.objectContaining({
              batchTransfer: expect.objectContaining({ batchCount: 0 }),
            }),
          }),
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

  it.each(['started', 'failed'] as const)(
    'joins in-flight startup before acknowledging Stop (%s)',
    async (outcome) => {
      storeState.hasHydrated = true;
      const starting = Promise.withResolvers<{ stop: typeof stopMock }>();
      startEmbeddingWorkerMock.mockReturnValue(starting.promise);
      const view = render(<EmbeddingHostRuntime />);
      await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce());
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
          starting.resolve({ stop: stopMock });
        } else {
          starting.reject(new Error('Startup device is unavailable'));
        }
      });
      await waitFor(() =>
        expect(reportStatusMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ commandId: command.requestId, state: 'stopped' })
        )
      );
      expect(reportStatusMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: 'running' })
      );
      expect(reportStatusMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: 'error' })
      );
      expect(stopMock).toHaveBeenCalledTimes(outcome === 'started' ? 1 : 0);
      view.unmount();
    }
  );

  it.each(['stop', 'reset'] as const)(
    'reports a failed %s without starting a replacement worker',
    async (action) => {
      storeState.hasHydrated = true;
      const view = render(<EmbeddingHostRuntime />);
      await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce());
      stopMock.mockRejectedValueOnce(new Error('Worker drain failed'));
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
      expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
      view.unmount();
    }
  );

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
    'joins the old database worker Stop before replacement (%s)',
    async (outcome) => {
      storeState.hasHydrated = true;
      const stopping = Promise.withResolvers<void>();
      stopMock.mockReturnValueOnce(stopping.promise);
      const view = render(<EmbeddingHostRuntime />);
      await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce());
      reportStatusMock.mockClear();
      currentDbRef.current = { query: vi.fn() };
      view.rerender(<EmbeddingHostRuntime />);
      expect(startEmbeddingWorkerMock).toHaveBeenCalledOnce();
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
      expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(outcome === 'stopped' ? 2 : 1);
      view.unmount();
    }
  );

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
    // A user's search waits on the model read, and host-window work defaults to
    // background, which the desktop scheduler rejects while integrity is
    // contained (BST-1870): the read must name the foreground lane.
    expect(dbHandle.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM models'),
      ['Xenova/all-MiniLM-L6-v2'],
      expect.objectContaining({ priority: 'foreground' })
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

  it('keeps telemetry reports active while a foreground query embedding is running', async () => {
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
    startEmbeddingWorkerMock.mockImplementationOnce(async (options) => {
      options.onRuntimeMetadataChange?.({
        device: 'webgpu',
        dtype: 'fp32',
        fallbackApplied: false,
      });
      return { stop: stopMock };
    });
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
    await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalled());
    const listener = queryEmbeddingListenerRef.current;
    if (!listener) {
      throw new Error('Missing query listener');
    }
    dbHandle.query.mockClear();
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
      runtime: { device: 'wasm', dtype, fallbackApplied: false, revision: plan.revision },
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
    expect(dbHandle.query).not.toHaveBeenCalled();
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
  it.each([
    undefined,
    { ...result().runtime, device: 'webgpu' },
    { ...result().runtime, dtype: 'fp32' },
    { ...result().runtime, fallbackApplied: true },
    { ...result().runtime, revision: 'main' },
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
