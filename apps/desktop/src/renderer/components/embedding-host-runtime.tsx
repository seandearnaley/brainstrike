import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { createBoundaryCapability } from '@brainstrike/assistant-contract/boundary-result';
import { getEmbeddingTelemetrySnapshot } from '@brainstrike/embedding-worker';
import { resolveViteEmbeddingWorkerUrlHref } from '@brainstrike/embedding-worker/vite';
import type { EmbeddingResult } from '@brainstrike/embeddings';
import { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import {
  createForegroundEmbeddingGate,
  type ForegroundEmbeddingGate,
  POWER_BROADCAST_CHANNEL,
  runCoordinatedQueryEmbedding,
} from '@brainstrike/embeddings/worker';
import { createLogger } from '@brainstrike/logging';
import { type MutableRefObject, useEffect, useRef } from 'react';
import {
  createEmbeddingHostDocumentEmbeddingsErrorReport,
  createEmbeddingHostDocumentEmbeddingsProgressReport,
  createEmbeddingHostDocumentEmbeddingsResultReport,
  createEmbeddingHostQueryEmbeddingErrorReport,
  createEmbeddingHostQueryEmbeddingResultReport,
  type EmbeddingHostInferenceRequest,
  type EmbeddingHostRuntimeMetadata,
} from '../../embedding-host-shared';
import {
  getEmbeddingHostBridge,
  getPowerBridge,
  reportDocumentEmbeddingsResponse,
  reportEmbeddingHostRuntimeStatus,
  reportEmbeddingHostRuntimeStatusForRuntimeId,
  reportQueryEmbeddingResponse,
} from './embedding-host-bridge';
import { subscribeDocumentEmbeddingsRequests } from './embedding-host-document-listener';
import {
  createEmbeddingHostCommandHandler,
  createEmbeddingHostLifecycleFailureHandler,
  runEmbeddingHostCleanupStep,
} from './embedding-host-lifecycle';
import { subscribeQueryEmbeddingRequests } from './embedding-host-query-listener';
import {
  assertPinnedQueryEmbeddingResult,
  loadQueryEmbeddingModelConfig,
  queryEmbeddingServiceIdentity,
} from './embedding-host-query-model';
import {
  closeQueryEmbeddingRuntimeOwner,
  createQueryEmbeddingRuntimeOwner,
  disposeQueryEmbeddingService,
  joinQueryEmbeddingFailure,
  type QueryEmbeddingRuntimeOwner,
  type QueryEmbeddingServiceState,
  runOwnedQueryEmbeddingInference,
} from './embedding-host-query-owner';
import {
  createBackendMismatchError,
  createEmbeddingRuntimeMetadata,
  embeddingHostDevice,
  withResolvedHostDevice,
} from './embedding-host-runtime-metadata';
import { answerWebGpuAdapterRequest } from './embedding-host-webgpu';
import { resolveHydratedVectorDevicePreference } from './embedding-host-worker-preferences';
import { startEmbeddingTelemetryReporter } from './embedding-telemetry-reporter';

const logger = createLogger('EmbeddingHostRuntime');
const QUERY_DRAIN_TIMEOUT_MS = 5000;
async function ensureEmbeddingQueueBootstrapLoaded(isCurrent: () => boolean): Promise<void> {
  const module = await import('../create-embedding-queue');
  await module.reopenEmbeddingQueue(isCurrent);
}

async function retireEmbeddingQueue(): Promise<void> {
  const module = await import('../create-embedding-queue');
  await module.retireEmbeddingQueue();
}

function assertEmbeddingResultDimensions(
  request: EmbeddingHostInferenceRequest,
  result: EmbeddingResult
): void {
  if (result.embedding.length === request.payload.dimensions) {
    return;
  }
  throw new Error(
    `Local query embedding dimension mismatch for ${request.payload.modelKey}: expected ${request.payload.dimensions}, got ${result.embedding.length}.`
  );
}

function assertQueryEmbeddingRuntimeCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw new Error('Embedding host query runtime is no longer available.');
  }
}

async function getQueryEmbeddingService(
  catalog: Pick<ModelCatalogCapability, 'read'> | undefined,
  request: EmbeddingHostInferenceRequest,
  runtimeIdRef: MutableRefObject<string>,
  owner: QueryEmbeddingRuntimeOwner,
  isCurrent: () => boolean,
  onServiceDisposalFailure: (error: unknown) => void,
  signal: AbortSignal
): Promise<QueryEmbeddingServiceState> {
  signal.throwIfAborted();
  const serviceStateRef = owner.serviceStateRef;
  assertQueryEmbeddingRuntimeCurrent(isCurrent);
  const existing = serviceStateRef.current;
  const identity = queryEmbeddingServiceIdentity(request);
  if (existing?.identity === identity) {
    return existing;
  }
  try {
    await disposeQueryEmbeddingService(runtimeIdRef, owner);
  } catch (error) {
    const current = isCurrent();
    owner.closed = true;
    if (current) {
      onServiceDisposalFailure(error);
    }
    throw error;
  }
  assertQueryEmbeddingRuntimeCurrent(isCurrent);
  signal.throwIfAborted();
  const modelConfig = await loadQueryEmbeddingModelConfig(catalog, request);
  assertQueryEmbeddingRuntimeCurrent(isCurrent);
  signal.throwIfAborted();
  const plan = request.payload.inferencePlan;
  const hydratedDevicePref = plan?.device ?? (await resolveHydratedVectorDevicePreference());
  assertQueryEmbeddingRuntimeCurrent(isCurrent);
  signal.throwIfAborted();
  const service = new SimpleEmbeddingService({
    streamingWorkerUrl: resolveViteEmbeddingWorkerUrlHref(),
  });
  if (plan) {
    await service.initialize({ ...plan, modelConfig });
  } else {
    await service.initializeWithModel(modelConfig, undefined, hydratedDevicePref);
  }
  if (!isCurrent()) {
    await service.dispose();
    assertQueryEmbeddingRuntimeCurrent(isCurrent);
  }
  const state: QueryEmbeddingServiceState = {
    identity,
    modelKey: request.payload.modelKey,
    selectedDevicePreference: hydratedDevicePref,
    service,
  };
  serviceStateRef.current = state;
  signal.throwIfAborted();
  return state;
}

async function handleQueryEmbeddingRequest(options: {
  readonly activeRef: MutableRefObject<boolean>;
  readonly catalog: Pick<ModelCatalogCapability, 'read'> | undefined;
  readonly embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>;
  readonly fatalErrorRef: MutableRefObject<string | null>;
  readonly gate: ForegroundEmbeddingGate;
  readonly isCurrent: () => boolean;
  readonly queryOwner: QueryEmbeddingRuntimeOwner;
  readonly signal: AbortSignal;
  readonly queryEmbeddingActiveCountRef: MutableRefObject<number>;
  readonly request: EmbeddingHostInferenceRequest;
  readonly runtimeIdRef: MutableRefObject<string>;
}): Promise<void> {
  const {
    activeRef,
    catalog,
    embeddingRuntimeRef,
    fatalErrorRef,
    gate,
    isCurrent,
    queryOwner,
    signal,
    queryEmbeddingActiveCountRef,
    request,
    runtimeIdRef,
  } = options;

  const startedAt = performance.now();
  const reportQueryPhase = (stage: 'service-preparation' | 'inference' | 'complete'): void => {
    if (request.channel !== 'query-embedding') {
      return;
    }
    logger.info('Embedding host query execution phase', {
      elapsedMs: Math.max(0, performance.now() - startedAt),
      provider: 'local',
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      stage,
    });
  };
  queryEmbeddingActiveCountRef.current += 1;
  reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'running', {
    active: true,
    embeddingRuntime: embeddingRuntimeRef.current,
  });
  try {
    signal.throwIfAborted();
    if (fatalErrorRef.current) {
      throw new Error(fatalErrorRef.current);
    }
    if (request.runtimeId !== runtimeIdRef.current) {
      throw new Error('Embedding host query request targeted a stale runtime.');
    }
    const result = await runCoordinatedQueryEmbedding({
      drainTimeoutMs: QUERY_DRAIN_TIMEOUT_MS,
      gate,
      generate: async () => {
        reportQueryPhase('service-preparation');
        const serviceState = await getQueryEmbeddingService(
          catalog,
          request,
          runtimeIdRef,
          queryOwner,
          isCurrent,
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            fatalErrorRef.current = message;
            queryEmbeddingActiveCountRef.current = 0;
            reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
              active: false,
              embeddingRuntime: embeddingRuntimeRef.current,
              lastError: message,
            });
          },
          signal
        );
        assertQueryEmbeddingRuntimeCurrent(isCurrent);
        reportQueryPhase('inference');
        const generated = await runOwnedQueryEmbeddingInference<
          EmbeddingResult | EmbeddingResult[]
        >(
          queryOwner,
          (inferenceSignal) =>
            request.channel === 'document-embeddings'
              ? serviceState.service.generateEmbeddings(request.payload.texts, {
                  // Main re-arms the batch window on each slice (liveness, not settlement).
                  onProgress: (completed) =>
                    reportDocumentEmbeddingsResponse(
                      createEmbeddingHostDocumentEmbeddingsProgressReport(request, completed)
                    ),
                  signal: inferenceSignal,
                })
              : serviceState.service.generateQueryEmbedding(request.payload.query, {
                  signal: inferenceSignal,
                }),
          signal
        );
        assertQueryEmbeddingRuntimeCurrent(isCurrent);
        signal.throwIfAborted();
        const results = Array.isArray(generated) ? generated : [generated];
        const expectedCount =
          request.channel === 'document-embeddings' ? request.payload.texts.length : 1;
        if (results.length !== expectedCount) {
          throw new Error('Embedding host returned an incorrect vector count.');
        }
        for (const result of results) {
          assertEmbeddingResultDimensions(request, result);
          assertPinnedQueryEmbeddingResult(request, result);
        }
        reportQueryPhase('complete');
        const runtime = results[0]?.runtime;
        if (runtime) {
          embeddingRuntimeRef.current = createEmbeddingRuntimeMetadata(
            serviceState.selectedDevicePreference,
            runtime,
            embeddingHostDevice(embeddingRuntimeRef.current)
          );
          const mismatch = createBackendMismatchError(embeddingRuntimeRef.current);
          if (mismatch) {
            fatalErrorRef.current = mismatch;
            throw new Error(mismatch);
          }
          reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'running', {
            active: true,
            embeddingRuntime: embeddingRuntimeRef.current,
          });
        }
        return generated;
      },
      isWorkerActive: () => activeRef.current,
      onDrainTimeout: () => {
        logger.warn('Embedding host query rejected because background drain did not complete', {
          requestId: request.requestId,
          runtimeId: request.runtimeId,
        });
      },
      signal,
    });
    if (request.channel === 'document-embeddings' && Array.isArray(result)) {
      reportDocumentEmbeddingsResponse(
        createEmbeddingHostDocumentEmbeddingsResultReport(
          request,
          result.map((item) => item.embedding)
        )
      );
    } else if (request.channel === 'query-embedding' && !Array.isArray(result)) {
      reportQueryEmbeddingResponse(
        createEmbeddingHostQueryEmbeddingResultReport(request, result.embedding)
      );
    } else {
      throw new Error('Embedding response did not match request kind.');
    }
  } catch (requestError) {
    const error = await joinQueryEmbeddingFailure(queryOwner, requestError);
    logger.error('Embedding host query embedding request failed', {
      error: error instanceof Error ? error.message : String(error),
      modelKey: request.payload.modelKey,
      requestId: request.requestId,
      runtimeId: request.runtimeId,
    });
    if (request.channel === 'document-embeddings') {
      reportDocumentEmbeddingsResponse(
        createEmbeddingHostDocumentEmbeddingsErrorReport(request, error)
      );
    } else {
      reportQueryEmbeddingResponse(createEmbeddingHostQueryEmbeddingErrorReport(request, error));
    }
  } finally {
    if (isCurrent()) {
      queryEmbeddingActiveCountRef.current = Math.max(queryEmbeddingActiveCountRef.current - 1, 0);
      reportEmbeddingHostRuntimeStatus(runtimeIdRef, fatalErrorRef.current ? 'error' : 'running', {
        active: activeRef.current || queryEmbeddingActiveCountRef.current > 0,
        embeddingRuntime: embeddingRuntimeRef.current,
        lastError: fatalErrorRef.current,
      });
    }
  }
}

function resolveEmbeddingHostRuntimeId(): string {
  const runtimeId = new URLSearchParams(window.location.search).get('runtimeId');
  if (!(runtimeId && runtimeId.trim().length > 0)) {
    throw new Error('Embedding host renderer requires a runtimeId query parameter.');
  }
  return runtimeId;
}

async function startEmbeddingHostWorkerRuntime(options: {
  readonly isCurrent: () => boolean;
  readonly runtimeIdRef: MutableRefObject<string>;
}): Promise<void> {
  reportEmbeddingHostRuntimeStatus(options.runtimeIdRef, 'starting');
  await ensureEmbeddingQueueBootstrapLoaded(options.isCurrent);
  if (options.isCurrent()) {
    reportEmbeddingHostRuntimeStatus(options.runtimeIdRef, 'running');
  }
}

export function EmbeddingHostRuntime(): null {
  const embeddingRuntimeRef = useRef<EmbeddingHostRuntimeMetadata | null>(null);
  const fatalErrorRef = useRef<string | null>(null);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const activeRef = useRef(false);
  const runtimeIdRef = useRef<string>(resolveEmbeddingHostRuntimeId());
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const stoppedByCommandRef = useRef(false);
  const controlsRef = useRef<{
    stop(): Promise<void>;
    reset(nextRuntimeId: string): Promise<void>;
    startBackground(): Promise<void>;
  } | null>(null);
  const queryEmbeddingOwnerRef = useRef<QueryEmbeddingRuntimeOwner | null>(null);
  const gateRef = useRef<ForegroundEmbeddingGate>(createForegroundEmbeddingGate());

  useEffect(() => {
    const catalog = window.modelCatalog
      ? createBoundaryCapability<Pick<ModelCatalogCapability, 'read'>>(window.modelCatalog)
      : undefined;
    let queryOwner = createQueryEmbeddingRuntimeOwner(catalog);
    queryEmbeddingOwnerRef.current = queryOwner;
    const queryEmbeddingActiveCountRef = queryOwner.activeCountRef;
    let disposed = false;
    const disposeEmbeddingTelemetryReporter = startEmbeddingTelemetryReporter({
      embeddingRuntimeRef,
      isClosed: () => queryOwner.closed,
      isDisposed: () => disposed,
      reportStatus: () => {
        const fatalError = fatalErrorRef.current;
        reportEmbeddingHostRuntimeStatus(runtimeIdRef, fatalError ? 'error' : 'running', {
          active: fatalError
            ? queryOwner.inferenceRef.current !== null
            : activeRef.current || queryEmbeddingActiveCountRef.current > 0,
          embeddingRuntime: embeddingRuntimeRef.current,
          lastError: fatalError,
        });
      },
    });

    const reportLifecycleFailure = createEmbeddingHostLifecycleFailureHandler(
      runtimeIdRef,
      () => disposed,
      (message) => {
        fatalErrorRef.current = message;
        activeRef.current = false;
        reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
          embeddingRuntime: embeddingRuntimeRef.current,
          lastError: message,
        });
      }
    );

    const startWorker = async (): Promise<void> => {
      if (stoppedByCommandRef.current) {
        return;
      }
      // Join Stop before registering a new start, so Stop never waits on itself.
      if (stopPromiseRef.current) {
        await stopPromiseRef.current;
      }
      if (stoppedByCommandRef.current) {
        return;
      }
      if (queryOwner.closed) {
        queryOwner = createQueryEmbeddingRuntimeOwner(catalog, queryEmbeddingActiveCountRef);
        queryEmbeddingOwnerRef.current = queryOwner;
      }
      if (startPromiseRef.current) {
        return startPromiseRef.current;
      }
      const started = startEmbeddingHostWorkerRuntime({
        isCurrent: () => !(disposed || stoppedByCommandRef.current || stopPromiseRef.current),
        runtimeIdRef,
      });
      startPromiseRef.current = started;
      try {
        await started;
      } finally {
        if (startPromiseRef.current === started) {
          startPromiseRef.current = null;
        }
      }
    };

    const stopWorker = (
      reason:
        | 'command-reset'
        | 'command-stop'
        | 'dispose'
        | 'fatal-worker-restart'
        | 'post-start-dispose',
      reportRuntimeId: string = runtimeIdRef.current
    ): Promise<void> => {
      if (stopPromiseRef.current) {
        return stopPromiseRef.current;
      }

      const stoppingQueryOwner = queryOwner;
      const closeQueries = closeQueryEmbeddingRuntimeOwner(
        stoppingQueryOwner,
        retireEmbeddingQueue,
        runtimeIdRef
      );
      const stopPromise = (async () => {
        logger.info('Stopping embedding host worker', {
          reason,
          reportRuntimeId,
          runtimeId: runtimeIdRef.current,
        });
        const stopped = await Promise.allSettled([
          closeQueries,
          (async () => {
            if (startPromiseRef.current) {
              await startPromiseRef.current;
            }
            fatalErrorRef.current = null;
            activeRef.current = false;
            queryEmbeddingActiveCountRef.current = 0;
          })(),
        ]);
        const failures = stopped.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Embedding host Stop failed');
        }
        if (disposed) {
          return;
        }
        const embeddingRuntime = embeddingRuntimeRef.current;
        if (embeddingRuntime) {
          embeddingRuntimeRef.current = {
            ...embeddingRuntime,
            telemetry: getEmbeddingTelemetrySnapshot(),
          };
        }
        reportEmbeddingHostRuntimeStatusForRuntimeId(reportRuntimeId, 'stopped', {
          embeddingRuntime: embeddingRuntimeRef.current,
        });
      })();

      const trackedStopPromise = stopPromise.finally(() => {
        if (stopPromiseRef.current === trackedStopPromise) {
          stopPromiseRef.current = null;
        }
      });
      stopPromiseRef.current = trackedStopPromise;
      return trackedStopPromise;
    };

    const resetWorker = async (nextRuntimeId: string): Promise<void> => {
      const previousRuntimeId = runtimeIdRef.current;
      logger.info('Resetting embedding host worker runtime', {
        nextRuntimeId,
        previousRuntimeId,
      });
      await stopWorker('command-reset', previousRuntimeId);
      if (disposed) {
        throw new Error('Embedding host runtime is unavailable for reset.');
      }
      stoppedByCommandRef.current = false;
      runtimeIdRef.current = nextRuntimeId;
      await startWorker();
    };

    controlsRef.current = {
      reset: resetWorker,
      startBackground: async () => {
        throw new Error(
          'Desktop background indexing is owned by the native indexer, not a database job queue.'
        );
      },
      stop: () => stopWorker('command-stop'),
    };

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(POWER_BROADCAST_CHANNEL);
    }

    const cleanupPower = getPowerBridge()?.onPowerState?.((state: 'resume' | 'suspend') => {
      channel?.postMessage(state);
    });

    void startWorker().catch((error: unknown) => {
      reportLifecycleFailure('Embedding host startup could not join the previous worker', error);
    });

    return () => {
      disposed = true;
      if (queryEmbeddingOwnerRef.current === queryOwner) {
        queryEmbeddingOwnerRef.current = null;
      }
      logger.info('Disposing embedding host runtime effect', {
        runtimeId: runtimeIdRef.current,
      });
      runEmbeddingHostCleanupStep(runtimeIdRef, 'Embedding host power cleanup failed', () => {
        cleanupPower?.();
      });
      runEmbeddingHostCleanupStep(runtimeIdRef, 'Embedding host telemetry cleanup failed', () => {
        disposeEmbeddingTelemetryReporter();
      });
      try {
        channel?.close();
      } catch (error) {
        logger.error('Embedding host power channel cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
          runtimeId: runtimeIdRef.current,
        });
      }
      void stopWorker('dispose').catch((error: unknown) => {
        reportLifecycleFailure('Embedding host disposal failed', error);
      });
    };
  }, []);

  useEffect(
    () =>
      subscribeQueryEmbeddingRequests({
        handle: ({ queryOwner, request, signal, isCurrent }) =>
          handleQueryEmbeddingRequest({
            activeRef,
            catalog: queryOwner.catalog,
            embeddingRuntimeRef,
            fatalErrorRef,
            gate: gateRef.current,
            isCurrent,
            queryEmbeddingActiveCountRef: queryOwner.activeCountRef,
            queryOwner,
            request,
            runtimeIdRef,
            signal,
          }),
        isStopping: () => stoppedByCommandRef.current || stopPromiseRef.current !== null,
        ownerRef: queryEmbeddingOwnerRef,
        runtimeIdRef,
      }),
    []
  );
  useEffect(
    () =>
      subscribeDocumentEmbeddingsRequests({
        handle: ({ queryOwner, request, signal, isCurrent }) =>
          handleQueryEmbeddingRequest({
            activeRef,
            catalog: queryOwner.catalog,
            embeddingRuntimeRef,
            fatalErrorRef,
            gate: gateRef.current,
            isCurrent,
            queryEmbeddingActiveCountRef: queryOwner.activeCountRef,
            queryOwner,
            request,
            runtimeIdRef,
            signal,
          }),
        isStopping: () => stoppedByCommandRef.current || stopPromiseRef.current !== null,
        ownerRef: queryEmbeddingOwnerRef,
        runtimeIdRef,
      }),
    []
  );

  // Settings asks for this host's WebGPU detection with its own request and response, so
  // status reports stay canonical for the renderer's runtime store (BST-1993).
  useEffect(() => {
    const bridge = getEmbeddingHostBridge();
    const report = bridge?.reportWebgpuAdapterResponse;
    if (!(bridge?.onWebgpuAdapterRequest && report)) {
      return;
    }
    return bridge.onWebgpuAdapterRequest((request) => {
      answerWebGpuAdapterRequest(request, report).catch((error: unknown) => {
        logger.error('Embedding host could not answer a WebGPU adapter request', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = getEmbeddingHostBridge()?.onCommand?.(
      createEmbeddingHostCommandHandler({
        getRuntimeId: () => runtimeIdRef.current,
        isDisposed: () => disposed,
        isFailed: () => fatalErrorRef.current !== null,
        isStopping: () => stoppedByCommandRef.current || stopPromiseRef.current !== null,
        report: (runtimeId, state, commandId, lastError) =>
          reportEmbeddingHostRuntimeStatusForRuntimeId(runtimeId, state, {
            active:
              state !== 'stopped' &&
              (activeRef.current ||
                (queryEmbeddingOwnerRef.current?.activeCountRef.current ?? 0) > 0),
            commandId,
            embeddingRuntime: embeddingRuntimeRef.current,
            ...(lastError === undefined ? {} : { lastError }),
          }),
        reset: async (nextRuntimeId) => {
          stoppedByCommandRef.current = true;
          const controls = controlsRef.current;
          if (!controls) {
            throw new Error('Embedding host runtime is unavailable for reset.');
          }
          await controls.reset(nextRuntimeId);
        },
        resolveDevice: async () => {
          const current = embeddingRuntimeRef.current;
          // Only the device an unpinned load uses; the worker keeps its own until restart.
          const next = current
            ? await withResolvedHostDevice(current, resolveHydratedVectorDevicePreference)
            : null;
          if (next && !disposed && embeddingRuntimeRef.current === current) {
            embeddingRuntimeRef.current = next;
            reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'running', {
              active: activeRef.current,
              embeddingRuntime: next,
            });
          }
        },
        startBackground: async () => {
          const controls = controlsRef.current;
          if (!controls) {
            throw new Error('Embedding host runtime is unavailable for background startup.');
          }
          await controls.startBackground();
        },
        stop: async () => {
          stoppedByCommandRef.current = true;
          await controlsRef.current?.stop();
        },
      })
    );
    return () => {
      disposed = true;
      runEmbeddingHostCleanupStep(runtimeIdRef, 'Embedding host command cleanup failed', () =>
        unsubscribe?.()
      );
    };
  }, []);

  return null;
}
