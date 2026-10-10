import {
  ensureVectorPreferencesHydrated,
  useVectorPreferencesStore,
} from '@brainstrike/app-state/stores/vector-preferences-store';
import { createEmbeddingCacheRepository } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { getEmbeddingTelemetrySnapshot } from '@brainstrike/embedding-worker';
import { resolveViteEmbeddingWorkerUrlHref } from '@brainstrike/embedding-worker/vite';
import {
  type DeviceCapabilities,
  detectDeviceCapabilities,
  type EmbeddingDeviceType,
  type EmbeddingResult,
} from '@brainstrike/embeddings';
import { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import {
  createForegroundEmbeddingGate,
  type EmbeddingWorkerController,
  type ForegroundEmbeddingGate,
  POWER_BROADCAST_CHANNEL,
  runCoordinatedQueryEmbedding,
  startEmbeddingWorker,
} from '@brainstrike/embeddings/worker';
import { createLogger } from '@brainstrike/logging';
import { type MutableRefObject, useEffect, useRef } from 'react';
import {
  createEmbeddingHostDocumentEmbeddingsErrorReport,
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
  type QueryEmbeddingRuntimeOwner,
  runOwnedQueryEmbeddingInference,
  stopEmbeddingHostAfterRestartLimit,
} from './embedding-host-query-owner';
import {
  createBackendMismatchError,
  createEmbeddingRuntimeMetadata,
  embeddingHostDevice,
  withResolvedHostDevice,
} from './embedding-host-runtime-metadata';
import { startEmbeddingTelemetryReporter } from './embedding-telemetry-reporter';
import { createEmbeddingWorkerConfig } from './embedding-worker-config';

const logger = createLogger('EmbeddingHostRuntime');
const QUERY_DRAIN_TIMEOUT_MS = 5000;
const MAX_RECOVERABLE_WEBGPU_DEVICE_LOSS_RESTARTS = 2;
const AUTOMATIC_WASM_RECOMMENDATION_ERROR =
  'Workspace Index requires WebGPU for automatic local embedding execution. Device detection recommended WASM, which is a slow/debug backend and will not be selected automatically.';

interface HydratedEmbeddingWorkerPreferences {
  readonly devicePref: EmbeddingDeviceType;
  readonly reinitEveryN: number;
}

async function ensureEmbeddingQueueBootstrapLoaded(isCurrent: () => boolean): Promise<void> {
  const module = await import('../create-embedding-queue');
  await module.reopenEmbeddingQueue(isCurrent);
}

async function retireEmbeddingQueue(): Promise<void> {
  const module = await import('../create-embedding-queue');
  await module.retireEmbeddingQueue();
}

function createFatalErrorHandler(
  runtimeIdRef: MutableRefObject<string>,
  embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>,
  fatalErrorRef: MutableRefObject<string | null>,
  activeRef: MutableRefObject<boolean>,
  isQueryInferenceActive: () => boolean
): (error: Error) => void {
  return (error: Error) => {
    const message = error.message;
    fatalErrorRef.current = message;
    activeRef.current = false;
    logger.error('Embedding host worker stopped after fatal local model error', {
      error: message,
      runtimeId: runtimeIdRef.current,
    });
    reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
      active: isQueryInferenceActive(),
      embeddingRuntime: embeddingRuntimeRef.current,
      lastError: message,
    });
  };
}

function isRecoverableEmbeddingWorkerFatalError(message: string): boolean {
  return /WebGPU device lost|device lost/i.test(message);
}

function createAutomaticWasmRecommendationError(detected: DeviceCapabilities): Error {
  const details = [
    detected.recommendationReason,
    detected.webgpuUnavailableReason,
    detected.webgpuApiPresent ? null : 'WebGPU API is not present.',
    detected.webgpuAdapterAvailable ? null : 'WebGPU adapter is unavailable.',
    detected.webWorkersAvailable ? null : 'Web Workers are unavailable.',
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return new Error(
    details.length > 0
      ? `${AUTOMATIC_WASM_RECOMMENDATION_ERROR} ${details.join(' ')}`
      : AUTOMATIC_WASM_RECOMMENDATION_ERROR
  );
}

async function resolveHydratedEmbeddingWorkerPreferences(): Promise<HydratedEmbeddingWorkerPreferences> {
  const vectorPreferences = await ensureVectorPreferencesHydrated({
    forceReload: true,
  });
  if (vectorPreferences.devicePrefConfigured) {
    return {
      devicePref: vectorPreferences.devicePref,
      reinitEveryN: vectorPreferences.reinitEveryN,
    };
  }

  const detected = await detectDeviceCapabilities();
  const detectedDevice = detected.recommendedDevice;
  if (detectedDevice === 'wasm') {
    if (vectorPreferences.devicePref !== 'webgpu') {
      useVectorPreferencesStore.getState().setDetectedDevicePref('webgpu');
    }
    throw createAutomaticWasmRecommendationError(detected);
  }
  if (vectorPreferences.devicePref !== detectedDevice) {
    useVectorPreferencesStore.getState().setDetectedDevicePref(detectedDevice);
  }
  return {
    devicePref: detectedDevice,
    reinitEveryN: vectorPreferences.reinitEveryN,
  };
}

async function resolveHydratedVectorDevicePreference(): Promise<EmbeddingDeviceType> {
  return (await resolveHydratedEmbeddingWorkerPreferences()).devicePref;
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
  db: NonNullable<ReturnType<typeof usePGliteDatabase>>,
  request: EmbeddingHostInferenceRequest,
  runtimeIdRef: MutableRefObject<string>,
  owner: QueryEmbeddingRuntimeOwner,
  isCurrent: () => boolean,
  onServiceDisposalFailure: (error: unknown) => void,
  signal: AbortSignal
): Promise<SimpleEmbeddingService> {
  signal.throwIfAborted();
  const serviceStateRef = owner.serviceStateRef;
  assertQueryEmbeddingRuntimeCurrent(isCurrent);
  const existing = serviceStateRef.current;
  const identity = queryEmbeddingServiceIdentity(request);
  if (existing?.identity === identity) {
    return existing.service;
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
  const modelConfig = await loadQueryEmbeddingModelConfig(db, request);
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
  serviceStateRef.current = {
    identity,
    modelKey: request.payload.modelKey,
    service,
  };
  signal.throwIfAborted();
  return service;
}

async function handleQueryEmbeddingRequest(options: {
  readonly activeRef: MutableRefObject<boolean>;
  readonly db: NonNullable<ReturnType<typeof usePGliteDatabase>>;
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
    db,
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
        const service = await getQueryEmbeddingService(
          db,
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
              ? service.generateEmbeddings(request.payload.texts, { signal: inferenceSignal })
              : service.generateQueryEmbedding(request.payload.query, { signal: inferenceSignal }),
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
          const selectedDevicePreference =
            request.payload.inferencePlan?.device ??
            embeddingRuntimeRef.current?.selectedDevicePreference ??
            runtime.device;
          embeddingRuntimeRef.current = createEmbeddingRuntimeMetadata(
            selectedDevicePreference,
            runtime,
            embeddingHostDevice(embeddingRuntimeRef.current)
          );
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
  } catch (error) {
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
      reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'running', {
        active: activeRef.current || queryEmbeddingActiveCountRef.current > 0,
        embeddingRuntime: embeddingRuntimeRef.current,
      });
    }
  }
}

function createActivityChangeHandler(
  runtimeIdRef: MutableRefObject<string>,
  embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>,
  fatalErrorRef: MutableRefObject<string | null>,
  activeRef: MutableRefObject<boolean>
): (active: boolean) => void {
  return (active: boolean) => {
    if (fatalErrorRef.current) {
      return;
    }
    activeRef.current = active;
    reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'running', {
      active,
      embeddingRuntime: embeddingRuntimeRef.current,
    });
  };
}

function resolveEmbeddingHostRuntimeId(): string {
  const runtimeId = new URLSearchParams(window.location.search).get('runtimeId');
  if (!(runtimeId && runtimeId.trim().length > 0)) {
    throw new Error('Embedding host renderer requires a runtimeId query parameter.');
  }
  return runtimeId;
}

interface StartEmbeddingHostWorkerOptions {
  readonly activeRef: MutableRefObject<boolean>;
  readonly controllerRef: MutableRefObject<EmbeddingWorkerController | null>;
  readonly db: NonNullable<ReturnType<typeof usePGliteDatabase>>;
  readonly embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>;
  readonly fatalErrorRef: MutableRefObject<string | null>;
  readonly gate: ForegroundEmbeddingGate;
  readonly isDisposed: () => boolean;
  readonly isStopping: () => boolean;
  readonly onFatalError: (error: Error) => void;
  readonly onWorkerActivityChange: (active: boolean) => void;
  readonly runtimeIdRef: MutableRefObject<string>;
  readonly startingRef: MutableRefObject<boolean>;
  readonly stopPromiseRef: MutableRefObject<Promise<void> | null>;
}

async function startEmbeddingHostWorkerRuntime({
  activeRef,
  controllerRef,
  db,
  embeddingRuntimeRef,
  fatalErrorRef,
  gate,
  isDisposed,
  isStopping,
  onFatalError,
  onWorkerActivityChange,
  runtimeIdRef,
  startingRef,
  stopPromiseRef,
}: StartEmbeddingHostWorkerOptions): Promise<void> {
  const pendingStop = stopPromiseRef.current;
  if (pendingStop) {
    await pendingStop;
  }
  if (isDisposed() || startingRef.current || controllerRef.current) {
    return;
  }

  startingRef.current = true;
  fatalErrorRef.current = null;
  reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'starting');

  try {
    await ensureEmbeddingQueueBootstrapLoaded(() => !(isDisposed() || isStopping()));
    if (isDisposed() || isStopping()) {
      return;
    }
    const hydratedPreferences = await resolveHydratedEmbeddingWorkerPreferences();
    const hydratedDevicePref = hydratedPreferences.devicePref;
    embeddingRuntimeRef.current = createEmbeddingRuntimeMetadata(hydratedDevicePref, null, {
      hostDevice: hydratedDevicePref,
    });
    const workerConfig = createEmbeddingWorkerConfig(db, gate);
    const controller = await startEmbeddingWorker({
      ...workerConfig,
      device: hydratedDevicePref,
      embeddingCache: createEmbeddingCacheRepository(workerConfig.db),
      initializeLocalModelOnStart: false,
      onFatalError,
      onRuntimeMetadataChange: (metadata) => {
        embeddingRuntimeRef.current = createEmbeddingRuntimeMetadata(
          hydratedDevicePref,
          metadata,
          embeddingHostDevice(embeddingRuntimeRef.current)
        );
        const backendMismatchError = createBackendMismatchError(embeddingRuntimeRef.current);
        if (backendMismatchError) {
          fatalErrorRef.current = backendMismatchError;
        }
        if (isStopping()) {
          return;
        }
        reportEmbeddingHostRuntimeStatus(runtimeIdRef, backendMismatchError ? 'error' : 'running', {
          active: backendMismatchError ? false : activeRef.current,
          embeddingRuntime: embeddingRuntimeRef.current,
          lastError: backendMismatchError,
        });
      },
      onWorkerActivityChange,
      reinitEveryN: hydratedPreferences.reinitEveryN,
      stopOnFatalLocalError: true,
      streamingWorkerUrl: resolveViteEmbeddingWorkerUrlHref(),
    });
    if (isDisposed()) {
      logger.info(
        'Stopping embedding host worker immediately after start because runtime is disposed',
        {
          runtimeId: runtimeIdRef.current,
        }
      );
      await controller.stop();
      return;
    }
    controllerRef.current = controller;
    if (isStopping()) {
      return;
    }
    const fatalError = fatalErrorRef.current;
    reportEmbeddingHostRuntimeStatus(runtimeIdRef, fatalError ? 'error' : 'running', {
      active: fatalError ? false : activeRef.current,
      embeddingRuntime: embeddingRuntimeRef.current,
      lastError: fatalError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start embedding host worker', {
      error: message,
      runtimeId: runtimeIdRef.current,
    });
    fatalErrorRef.current = message;
    if (!isStopping()) {
      reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
        lastError: message,
      });
    }
  } finally {
    startingRef.current = false;
  }
}

export function EmbeddingHostRuntime(): null {
  const db = usePGliteDatabase();
  const controllerRef = useRef<EmbeddingWorkerController | null>(null);
  const embeddingRuntimeRef = useRef<EmbeddingHostRuntimeMetadata | null>(null);
  const fatalErrorRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const activeRef = useRef(false);
  const runtimeIdRef = useRef<string>(resolveEmbeddingHostRuntimeId());
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const stoppedByCommandRef = useRef(false);
  const controlsRef = useRef<{
    stop(): Promise<void>;
    reset(nextRuntimeId: string): Promise<void>;
  } | null>(null);
  const queryEmbeddingOwnerRef = useRef<QueryEmbeddingRuntimeOwner | null>(null);
  const gateRef = useRef<ForegroundEmbeddingGate>(createForegroundEmbeddingGate());

  useEffect(() => {
    if (!db) {
      if (!stoppedByCommandRef.current) {
        reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'starting');
      }
      return;
    }

    let queryOwner = createQueryEmbeddingRuntimeOwner(db);
    queryEmbeddingOwnerRef.current = queryOwner;
    const queryEmbeddingActiveCountRef = queryOwner.activeCountRef;
    let disposed = false;
    let restartAfterFatalErrorPromise: Promise<void> | null = null;
    let recoverableDeviceLossRestartCount = 0;
    const onWorkerActivityChange = createActivityChangeHandler(
      runtimeIdRef,
      embeddingRuntimeRef,
      fatalErrorRef,
      activeRef
    );
    const disposeEmbeddingTelemetryReporter = startEmbeddingTelemetryReporter({
      controllerRef,
      embeddingRuntimeRef,
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
        queryOwner = createQueryEmbeddingRuntimeOwner(db, queryEmbeddingActiveCountRef);
        queryEmbeddingOwnerRef.current = queryOwner;
      }
      if (startPromiseRef.current) {
        return startPromiseRef.current;
      }
      const started = startEmbeddingHostWorkerRuntime({
        activeRef,
        controllerRef,
        db,
        embeddingRuntimeRef,
        fatalErrorRef,
        gate: gateRef.current,
        isDisposed: () => disposed,
        isStopping: () => stopPromiseRef.current !== null,
        onFatalError,
        onWorkerActivityChange,
        runtimeIdRef,
        startingRef,
        stopPromiseRef,
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
            const controller = controllerRef.current;
            controllerRef.current = null;
            fatalErrorRef.current = null;
            activeRef.current = false;
            queryEmbeddingActiveCountRef.current = 0;
            try {
              await controller?.stop();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              fatalErrorRef.current = message;
              reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
                active: stoppingQueryOwner.inferenceRef.current !== null,
                embeddingRuntime: embeddingRuntimeRef.current,
                lastError: message,
              });
              throw error;
            }
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

    const restartAfterFatalError = (message: string): void => {
      if (restartAfterFatalErrorPromise || disposed) {
        return;
      }
      if (recoverableDeviceLossRestartCount >= MAX_RECOVERABLE_WEBGPU_DEVICE_LOSS_RESTARTS) {
        const terminalError = `Embedding host stopped after repeated WebGPU device loss (${recoverableDeviceLossRestartCount} restart(s)): ${message}`;
        logger.error('Embedding host recoverable fatal restart limit reached', {
          error: message,
          restartCount: recoverableDeviceLossRestartCount,
          runtimeId: runtimeIdRef.current,
        });
        fatalErrorRef.current = terminalError;
        activeRef.current = false;
        const controller = controllerRef.current;
        controllerRef.current = null;
        restartAfterFatalErrorPromise = stopEmbeddingHostAfterRestartLimit({
          controller,
          embeddingRuntimeRef,
          isDisposed: () => disposed,
          queryOwner,
          retireQueue: retireEmbeddingQueue,
          runtimeIdRef,
          terminalError,
        }).finally(() => {
          restartAfterFatalErrorPromise = null;
        });
        return;
      }

      restartAfterFatalErrorPromise = (async () => {
        recoverableDeviceLossRestartCount += 1;
        logger.warn('Restarting embedding host worker after recoverable fatal error', {
          error: message,
          restartCount: recoverableDeviceLossRestartCount,
          runtimeId: runtimeIdRef.current,
        });
        await stopWorker('fatal-worker-restart');
        await startWorker();
      })()
        .catch((error: unknown) => {
          const restartError = error instanceof Error ? error.message : String(error);
          logger.error('Embedding host worker restart after fatal error failed', {
            error: restartError,
            runtimeId: runtimeIdRef.current,
          });
          fatalErrorRef.current = restartError;
          reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
            active: queryOwner.inferenceRef.current !== null,
            embeddingRuntime: embeddingRuntimeRef.current,
            lastError: restartError,
          });
        })
        .finally(() => {
          restartAfterFatalErrorPromise = null;
        });
    };

    const onFatalError = (error: Error): void => {
      createFatalErrorHandler(
        runtimeIdRef,
        embeddingRuntimeRef,
        fatalErrorRef,
        activeRef,
        () => queryOwner.inferenceRef.current !== null
      )(error);
      if (!isRecoverableEmbeddingWorkerFatalError(error.message)) {
        return;
      }
      restartAfterFatalError(error.message);
    };

    const resetWorker = async (nextRuntimeId: string): Promise<void> => {
      const previousRuntimeId = runtimeIdRef.current;
      logger.info('Resetting embedding host worker runtime', {
        nextRuntimeId,
        previousRuntimeId,
      });
      await stopWorker('command-reset', previousRuntimeId);
      if (disposed) {
        throw new Error('Embedding host database is unavailable for reset.');
      }
      stoppedByCommandRef.current = false;
      runtimeIdRef.current = nextRuntimeId;
      await startWorker();
    };

    controlsRef.current = { reset: resetWorker, stop: () => stopWorker('command-stop') };

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
  }, [db]);

  useEffect(
    () =>
      subscribeQueryEmbeddingRequests({
        handle: ({ queryOwner, request, signal, isCurrent }) =>
          handleQueryEmbeddingRequest({
            activeRef,
            db: queryOwner.db,
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
            db: queryOwner.db,
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

  useEffect(() => {
    let disposed = false;
    const unsubscribe = getEmbeddingHostBridge()?.onCommand?.(
      createEmbeddingHostCommandHandler({
        getRuntimeId: () => runtimeIdRef.current,
        isDisposed: () => disposed,
        report: (runtimeId, state, commandId, lastError) =>
          reportEmbeddingHostRuntimeStatusForRuntimeId(runtimeId, state, {
            commandId,
            embeddingRuntime: embeddingRuntimeRef.current,
            ...(lastError === undefined ? {} : { lastError }),
          }),
        reset: async (nextRuntimeId) => {
          stoppedByCommandRef.current = true;
          const controls = controlsRef.current;
          if (!controls) {
            throw new Error('Embedding host database is unavailable for reset.');
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
