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
  type ModelConfig,
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
  assertEmbeddingHostCommand,
  assertEmbeddingHostQueryEmbeddingRequest,
  createEmbeddingHostQueryEmbeddingErrorReport,
  createEmbeddingHostQueryEmbeddingResultReport,
  type EmbeddingHostCommand,
  type EmbeddingHostQueryEmbeddingRequest,
  type EmbeddingHostQueryEmbeddingResponseReport,
  type EmbeddingHostRuntimeMetadata,
  type EmbeddingHostStatus,
  type EmbeddingHostWorkerRuntimeMetadata,
} from '../../embedding-host-shared';
import {
  createEmbeddingHostLifecycleFailureHandler,
  createQueryEmbeddingRequestParseErrorReport,
  runEmbeddingHostCleanupStep,
} from './embedding-host-lifecycle';
import {
  createEmbeddingHostStatus,
  type EmbeddingHostStatusOptions,
} from './embedding-host-status';
import { startEmbeddingTelemetryReporter } from './embedding-telemetry-reporter';
import { createEmbeddingWorkerConfig } from './embedding-worker-config';

const logger = createLogger('EmbeddingHostRuntime');
const QUERY_DRAIN_TIMEOUT_MS = 5000;
const MAX_RECOVERABLE_WEBGPU_DEVICE_LOSS_RESTARTS = 2;
const AUTOMATIC_WASM_RECOMMENDATION_ERROR =
  'Workspace Index requires WebGPU for automatic local embedding execution. Device detection recommended WASM, which is a slow/debug backend and will not be selected automatically.';
let embeddingQueueBootstrapPromise: Promise<void> | null = null;

interface HydratedEmbeddingWorkerPreferences {
  readonly devicePref: EmbeddingDeviceType;
  readonly reinitEveryN: number;
}

async function ensureEmbeddingQueueBootstrapLoaded(): Promise<void> {
  if (!embeddingQueueBootstrapPromise) {
    embeddingQueueBootstrapPromise = import('../create-embedding-queue')
      .then((module) => {
        module.getEmbeddingQueue();
      })
      .catch((error: unknown) => {
        embeddingQueueBootstrapPromise = null;
        throw error;
      });
  }
  await embeddingQueueBootstrapPromise;
}

function getEmbeddingHostBridge(): {
  onCommand?: (callback: (command: EmbeddingHostCommand) => void) => () => void;
  onQueryEmbeddingRequest?: (
    callback: (request: EmbeddingHostQueryEmbeddingRequest) => void
  ) => () => void;
  reportQueryEmbeddingResponse?: (response: EmbeddingHostQueryEmbeddingResponseReport) => void;
  reportStatus?: (status: EmbeddingHostStatus) => void;
} | null {
  const hostWindow = window as Window & {
    embeddingHost?: {
      onCommand?: (callback: (command: EmbeddingHostCommand) => void) => () => void;
      onQueryEmbeddingRequest?: (
        callback: (request: EmbeddingHostQueryEmbeddingRequest) => void
      ) => () => void;
      reportQueryEmbeddingResponse?: (response: EmbeddingHostQueryEmbeddingResponseReport) => void;
      reportStatus?: (status: EmbeddingHostStatus) => void;
    };
  };
  return hostWindow.embeddingHost ?? null;
}

function getPowerBridge(): {
  onPowerState?: (callback: (state: 'resume' | 'suspend') => void) => () => void;
} | null {
  const hostWindow = window as Window & {
    power?: {
      onPowerState?: (callback: (state: 'resume' | 'suspend') => void) => () => void;
    };
  };
  return hostWindow.power ?? null;
}

function reportStatus(status: EmbeddingHostStatus): void {
  getEmbeddingHostBridge()?.reportStatus?.(status);
}

function reportQueryEmbeddingResponse(response: EmbeddingHostQueryEmbeddingResponseReport): void {
  getEmbeddingHostBridge()?.reportQueryEmbeddingResponse?.(response);
}

function reportEmbeddingHostRuntimeStatus(
  runtimeIdRef: MutableRefObject<string>,
  state: EmbeddingHostStatus['state'],
  options?: EmbeddingHostStatusOptions
): void {
  reportStatus(createEmbeddingHostStatus(runtimeIdRef.current, state, options));
}

function reportEmbeddingHostRuntimeStatusForRuntimeId(
  runtimeId: string,
  state: EmbeddingHostStatus['state'],
  options?: EmbeddingHostStatusOptions
): void {
  reportStatus(createEmbeddingHostStatus(runtimeId, state, options));
}

async function stopEmbeddingHostAfterRestartLimit(options: {
  readonly controller: EmbeddingWorkerController | null;
  readonly embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>;
  readonly isDisposed: () => boolean;
  readonly runtimeIdRef: MutableRefObject<string>;
  readonly terminalError: string;
}): Promise<void> {
  const { controller, embeddingRuntimeRef, isDisposed, runtimeIdRef, terminalError } = options;
  if (controller) {
    try {
      await controller.stop();
    } catch (error) {
      logger.error('Embedding host worker stop after restart limit failed', {
        error: error instanceof Error ? error.message : String(error),
        runtimeId: runtimeIdRef.current,
      });
    }
  }
  const currentMetadata = embeddingRuntimeRef.current;
  if (currentMetadata) {
    embeddingRuntimeRef.current = {
      ...currentMetadata,
      telemetry: getEmbeddingTelemetrySnapshot(),
    };
  }
  if (isDisposed()) {
    return;
  }
  reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
    embeddingRuntime: embeddingRuntimeRef.current,
    lastError: terminalError,
  });
}

function createFatalErrorHandler(
  runtimeIdRef: MutableRefObject<string>,
  embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>,
  fatalErrorRef: MutableRefObject<string | null>,
  activeRef: MutableRefObject<boolean>
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
      embeddingRuntime: embeddingRuntimeRef.current,
      lastError: message,
    });
  };
}

interface DbModelRow {
  readonly capabilities: unknown;
  readonly description: string | null;
  readonly id: string;
  readonly name: string;
  readonly parameters: unknown;
  readonly providerId: string;
}

interface QueryEmbeddingServiceState {
  readonly modelKey: string;
  readonly service: SimpleEmbeddingService;
}

function createEmbeddingRuntimeMetadata(
  selectedDevicePreference: EmbeddingDeviceType,
  actualWorkerMetadata: EmbeddingHostWorkerRuntimeMetadata | null
): EmbeddingHostRuntimeMetadata {
  return {
    actualWorkerMetadata,
    backendMismatch:
      actualWorkerMetadata !== null &&
      (actualWorkerMetadata.device !== selectedDevicePreference ||
        actualWorkerMetadata.fallbackApplied),
    selectedDevicePreference,
    telemetry: getEmbeddingTelemetrySnapshot(),
  };
}

function createBackendMismatchError(metadata: EmbeddingHostRuntimeMetadata): string | null {
  const actual = metadata.actualWorkerMetadata;
  if (!(metadata.backendMismatch && actual)) {
    return null;
  }
  const fallbackSuffix = actual.fallbackApplied ? ' with fallbackApplied=true' : '';
  return `Embedding backend mismatch: selected ${metadata.selectedDevicePreference}, actual ${actual.device}${fallbackSuffix}.`;
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

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function resolveOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function assertEmbeddingResultDimensions(
  request: EmbeddingHostQueryEmbeddingRequest,
  result: EmbeddingResult
): void {
  if (result.embedding.length === request.payload.dimensions) {
    return;
  }
  throw new Error(
    `Local query embedding dimension mismatch for ${request.payload.modelKey}: expected ${request.payload.dimensions}, got ${result.embedding.length}.`
  );
}

async function loadQueryEmbeddingModelConfig(
  db: NonNullable<ReturnType<typeof usePGliteDatabase>>,
  request: EmbeddingHostQueryEmbeddingRequest
): Promise<ModelConfig> {
  const result = await db.query<DbModelRow>(
    `SELECT
      id,
      provider_id AS "providerId",
      name,
      description,
      capabilities,
      parameters
     FROM models
     WHERE id = $1
     LIMIT 1`,
    [request.payload.modelId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Local embedding model ${request.payload.modelId} is not registered.`);
  }

  const capabilities = parseRecord(row.capabilities);
  const parameters = parseRecord(row.parameters);
  const dimensions = resolveOptionalNumber(capabilities['defaultDimension']);
  if (dimensions !== request.payload.dimensions) {
    throw new Error(
      `Local embedding model ${request.payload.modelId} dimensions do not match embedding set ${request.payload.modelKey}.`
    );
  }

  return {
    description: row.description ?? '',
    dimensions,
    id: row.id,
    name: row.name,
    origin: row.providerId,
    quantized: false,
    tags: [row.providerId, resolveOptionalString(capabilities['type']) ?? 'embedding'],
    ...(resolveOptionalString(parameters['size'])
      ? { size: resolveOptionalString(parameters['size']) }
      : {}),
    ...(resolveOptionalNumber(parameters['contextWindow'])
      ? { contextWindow: resolveOptionalNumber(parameters['contextWindow']) }
      : {}),
  };
}

async function disposeQueryEmbeddingService(
  runtimeIdRef: MutableRefObject<string>,
  serviceStateRef: MutableRefObject<QueryEmbeddingServiceState | null>
): Promise<void> {
  const state = serviceStateRef.current;
  serviceStateRef.current = null;
  if (!state) {
    return;
  }
  try {
    await state.service.dispose();
  } catch (error) {
    logger.warn('Failed to dispose local query embedding service', {
      error: error instanceof Error ? error.message : String(error),
      modelKey: state.modelKey,
      runtimeId: runtimeIdRef.current,
    });
  }
}

async function getQueryEmbeddingService(
  db: NonNullable<ReturnType<typeof usePGliteDatabase>>,
  request: EmbeddingHostQueryEmbeddingRequest,
  runtimeIdRef: MutableRefObject<string>,
  serviceStateRef: MutableRefObject<QueryEmbeddingServiceState | null>
): Promise<SimpleEmbeddingService> {
  const existing = serviceStateRef.current;
  if (existing?.modelKey === request.payload.modelKey) {
    return existing.service;
  }
  await disposeQueryEmbeddingService(runtimeIdRef, serviceStateRef);
  const modelConfig = await loadQueryEmbeddingModelConfig(db, request);
  const hydratedDevicePref = await resolveHydratedVectorDevicePreference();
  const service = new SimpleEmbeddingService({
    streamingWorkerUrl: resolveViteEmbeddingWorkerUrlHref(),
  });
  await service.initializeWithModel(modelConfig, undefined, hydratedDevicePref);
  serviceStateRef.current = {
    modelKey: request.payload.modelKey,
    service,
  };
  return service;
}

async function handleQueryEmbeddingRequest(options: {
  readonly activeRef: MutableRefObject<boolean>;
  readonly db: NonNullable<ReturnType<typeof usePGliteDatabase>>;
  readonly embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>;
  readonly fatalErrorRef: MutableRefObject<string | null>;
  readonly gate: ForegroundEmbeddingGate;
  readonly queryEmbeddingActiveCountRef: MutableRefObject<number>;
  readonly request: EmbeddingHostQueryEmbeddingRequest;
  readonly runtimeIdRef: MutableRefObject<string>;
  readonly serviceStateRef: MutableRefObject<QueryEmbeddingServiceState | null>;
}): Promise<void> {
  const {
    activeRef,
    db,
    embeddingRuntimeRef,
    fatalErrorRef,
    gate,
    queryEmbeddingActiveCountRef,
    request,
    runtimeIdRef,
    serviceStateRef,
  } = options;

  queryEmbeddingActiveCountRef.current += 1;
  reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'running', {
    active: true,
    embeddingRuntime: embeddingRuntimeRef.current,
  });
  try {
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
        const service = await getQueryEmbeddingService(db, request, runtimeIdRef, serviceStateRef);
        const generated = await service.generateQueryEmbedding(request.payload.query);
        assertEmbeddingResultDimensions(request, generated);
        if (generated.runtime) {
          const selectedDevicePreference =
            embeddingRuntimeRef.current?.selectedDevicePreference ?? generated.runtime.device;
          embeddingRuntimeRef.current = createEmbeddingRuntimeMetadata(
            selectedDevicePreference,
            generated.runtime
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
        logger.warn('Embedding host query proceeded before background drain completed', {
          requestId: request.requestId,
          runtimeId: request.runtimeId,
        });
      },
    });
    reportQueryEmbeddingResponse(
      createEmbeddingHostQueryEmbeddingResultReport(request, result.embedding)
    );
  } catch (error) {
    logger.error('Embedding host query embedding request failed', {
      error: error instanceof Error ? error.message : String(error),
      modelKey: request.payload.modelKey,
      requestId: request.requestId,
      runtimeId: request.runtimeId,
    });
    reportQueryEmbeddingResponse(createEmbeddingHostQueryEmbeddingErrorReport(request, error));
  } finally {
    queryEmbeddingActiveCountRef.current = Math.max(queryEmbeddingActiveCountRef.current - 1, 0);
    reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'running', {
      active: activeRef.current || queryEmbeddingActiveCountRef.current > 0,
      embeddingRuntime: embeddingRuntimeRef.current,
    });
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
    await ensureEmbeddingQueueBootstrapLoaded();
    const hydratedPreferences = await resolveHydratedEmbeddingWorkerPreferences();
    const hydratedDevicePref = hydratedPreferences.devicePref;
    embeddingRuntimeRef.current = createEmbeddingRuntimeMetadata(hydratedDevicePref, null);
    const workerConfig = createEmbeddingWorkerConfig(db, gate);
    const controller = await startEmbeddingWorker({
      ...workerConfig,
      device: hydratedDevicePref,
      embeddingCache: createEmbeddingCacheRepository(workerConfig.db),
      initializeLocalModelOnStart: false,
      onFatalError,
      onRuntimeMetadataChange: (metadata) => {
        embeddingRuntimeRef.current = createEmbeddingRuntimeMetadata(hydratedDevicePref, metadata);
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
  const queryEmbeddingActiveCountRef = useRef(0);
  const queryEmbeddingServiceStateRef = useRef<QueryEmbeddingServiceState | null>(null);
  const gateRef = useRef<ForegroundEmbeddingGate>(createForegroundEmbeddingGate());

  useEffect(() => {
    if (!db) {
      return;
    }

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
            ? false
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
      // Join Stop before registering a new start, so Stop never waits on itself.
      if (stopPromiseRef.current) {
        await stopPromiseRef.current;
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

      const stopPromise = (async () => {
        logger.info('Stopping embedding host worker', {
          reason,
          reportRuntimeId,
          runtimeId: runtimeIdRef.current,
        });
        if (startPromiseRef.current) {
          await startPromiseRef.current;
        }
        const controller = controllerRef.current;
        controllerRef.current = null;
        fatalErrorRef.current = null;
        activeRef.current = false;
        queryEmbeddingActiveCountRef.current = 0;
        if (controller) {
          await controller.stop();
        }
        await disposeQueryEmbeddingService(runtimeIdRef, queryEmbeddingServiceStateRef);
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
            embeddingRuntime: embeddingRuntimeRef.current,
            lastError: restartError,
          });
        })
        .finally(() => {
          restartAfterFatalErrorPromise = null;
        });
    };

    const onFatalError = (error: Error): void => {
      createFatalErrorHandler(runtimeIdRef, embeddingRuntimeRef, fatalErrorRef, activeRef)(error);
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
      runtimeIdRef.current = nextRuntimeId;
      await startWorker();
    };

    const unsubscribeCommand = getEmbeddingHostBridge()?.onCommand?.((command) => {
      const nextCommand = assertEmbeddingHostCommand(command);
      if (nextCommand.runtimeId !== runtimeIdRef.current) {
        logger.warn('Ignored embedding host command for stale runtime', {
          action: nextCommand.payload.action,
          commandRuntimeId: nextCommand.runtimeId,
          runtimeId: runtimeIdRef.current,
        });
        return;
      }
      if (nextCommand.payload.action === 'stop') {
        void stopWorker('command-stop').then(
          () => {
            if (!disposed) {
              reportEmbeddingHostRuntimeStatusForRuntimeId(nextCommand.runtimeId, 'stopped', {
                commandId: nextCommand.requestId,
                embeddingRuntime: embeddingRuntimeRef.current,
              });
            }
          },
          (error: unknown) => {
            logger.error('Embedding host Stop failed', { error, requestId: nextCommand.requestId });
            if (!disposed) {
              reportEmbeddingHostRuntimeStatusForRuntimeId(nextCommand.runtimeId, 'error', {
                commandId: nextCommand.requestId,
                lastError: error instanceof Error ? error.message : String(error),
              });
            }
          }
        );
        return;
      }
      if (nextCommand.payload.action === 'reset') {
        if (nextCommand.payload.nextRuntimeId === runtimeIdRef.current) {
          throw new Error('Embedding host reset requires a fresh nextRuntimeId.');
        }
        void resetWorker(nextCommand.payload.nextRuntimeId).catch((error: unknown) => {
          reportLifecycleFailure('Embedding host reset failed', error);
        });
      }
    });

    const unsubscribeQueryEmbedding = getEmbeddingHostBridge()?.onQueryEmbeddingRequest?.(
      (rawRequest) => {
        let request: EmbeddingHostQueryEmbeddingRequest;
        try {
          request = assertEmbeddingHostQueryEmbeddingRequest(rawRequest);
        } catch (error) {
          const response = createQueryEmbeddingRequestParseErrorReport(rawRequest, error);
          logger.error('Rejected invalid embedding host query embedding request', {
            error: error instanceof Error ? error.message : String(error),
            requestId: response?.requestId ?? null,
            runtimeId: response?.runtimeId ?? null,
          });
          if (response) {
            reportQueryEmbeddingResponse(response);
          }
          return;
        }
        void handleQueryEmbeddingRequest({
          activeRef,
          db,
          embeddingRuntimeRef,
          fatalErrorRef,
          gate: gateRef.current,
          queryEmbeddingActiveCountRef,
          request,
          runtimeIdRef,
          serviceStateRef: queryEmbeddingServiceStateRef,
        }).catch((error: unknown) => {
          logger.error('Unhandled embedding host query embedding request failure', {
            error,
            requestId: request.requestId,
          });
        });
      }
    );

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
      logger.info('Disposing embedding host runtime effect', {
        runtimeId: runtimeIdRef.current,
      });
      runEmbeddingHostCleanupStep(runtimeIdRef, 'Embedding host power cleanup failed', () => {
        cleanupPower?.();
      });
      runEmbeddingHostCleanupStep(runtimeIdRef, 'Embedding host command cleanup failed', () => {
        unsubscribeCommand?.();
      });
      runEmbeddingHostCleanupStep(
        runtimeIdRef,
        'Embedding host query embedding cleanup failed',
        () => {
          unsubscribeQueryEmbedding?.();
        }
      );
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

  return null;
}
