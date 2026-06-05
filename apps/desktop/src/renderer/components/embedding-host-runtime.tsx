import { createEmbeddingCacheRepository, usePGliteDatabase } from '@brainstrike/db';
import type { EmbeddingResult, ModelConfig } from '@brainstrike/embeddings';
import { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import {
  createForegroundEmbeddingGate,
  type EmbeddingWorkerController,
  type ForegroundEmbeddingGate,
  POWER_BROADCAST_CHANNEL,
  runCoordinatedQueryEmbedding,
  startEmbeddingWorker,
} from '@brainstrike/embeddings/worker';
import { ensureVectorPreferencesHydrated } from '@brainstrike/preferences/stores/vector-preferences-store';
import { createLogger } from '@brainstrike/utils/logger';
import { type MutableRefObject, useEffect, useRef } from 'react';
import {
  assertEmbeddingHostCommand,
  assertEmbeddingHostQueryEmbeddingRequest,
  createEmbeddingHostQueryEmbeddingErrorReport,
  createEmbeddingHostQueryEmbeddingResultReport,
  type EmbeddingHostCommand,
  type EmbeddingHostQueryEmbeddingRequest,
  type EmbeddingHostQueryEmbeddingResponseReport,
  type EmbeddingHostStatus,
} from '../../embedding-host-shared';
import { resolveEmbeddingWorkerUrlHref } from '../resolve-embedding-worker-url';
import { createEmbeddingWorkerConfig } from './embedding-worker-config';

const logger = createLogger('EmbeddingHostRuntime');
const QUERY_DRAIN_TIMEOUT_MS = 5000;
let embeddingQueueBootstrapPromise: Promise<void> | null = null;

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

function getEnvelopeStringField(value: unknown, field: 'requestId' | 'runtimeId'): string | null {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
}

function createQueryEmbeddingRequestParseErrorReport(
  rawRequest: unknown,
  error: unknown
): EmbeddingHostQueryEmbeddingResponseReport | null {
  const requestId = getEnvelopeStringField(rawRequest, 'requestId');
  const runtimeId = getEnvelopeStringField(rawRequest, 'runtimeId');
  if (!(requestId && runtimeId)) {
    return null;
  }
  return {
    type: 'error',
    channel: 'query-embedding-error',
    requestId,
    runtimeId,
    payload: {
      name: error instanceof Error && error.name.trim().length > 0 ? error.name : 'Error',
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'Invalid embedding host query embedding request.',
      ...(error instanceof Error && typeof error.stack === 'string' ? { stack: error.stack } : {}),
    },
  };
}

function createEmbeddingHostStatus(
  runtimeId: string,
  state: EmbeddingHostStatus['state'],
  options?: {
    active?: boolean;
    lastError?: string | null;
  }
): EmbeddingHostStatus {
  return {
    runtimeKind: 'embedding-host',
    runtimeId,
    state,
    active: options?.active ?? false,
    lastError: options?.lastError ?? null,
  };
}

function reportEmbeddingHostRuntimeStatus(
  runtimeIdRef: MutableRefObject<string>,
  state: EmbeddingHostStatus['state'],
  options?: {
    active?: boolean;
    lastError?: string | null;
  }
): void {
  reportStatus(createEmbeddingHostStatus(runtimeIdRef.current, state, options));
}

function reportEmbeddingHostRuntimeStatusForRuntimeId(
  runtimeId: string,
  state: EmbeddingHostStatus['state'],
  options?: {
    active?: boolean;
    lastError?: string | null;
  }
): void {
  reportStatus(createEmbeddingHostStatus(runtimeId, state, options));
}

function createFatalErrorHandler(
  runtimeIdRef: MutableRefObject<string>,
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
      lastError: message,
    });
  };
}

function runEmbeddingHostCleanupStep(
  runtimeIdRef: MutableRefObject<string>,
  label:
    | 'Embedding host command cleanup failed'
    | 'Embedding host query embedding cleanup failed'
    | 'Embedding host power channel cleanup failed'
    | 'Embedding host power cleanup failed',
  cleanup: () => void
): void {
  try {
    cleanup();
  } catch (error) {
    logger.error(label, {
      error: error instanceof Error ? error.message : String(error),
      runtimeId: runtimeIdRef.current,
    });
  }
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
    id: row.id,
    name: row.name,
    dimensions,
    quantized: false,
    description: row.description ?? '',
    tags: [row.providerId, resolveOptionalString(capabilities['type']) ?? 'embedding'],
    origin: row.providerId,
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
  const { devicePref: hydratedDevicePref } = await ensureVectorPreferencesHydrated({
    forceReload: true,
  });
  const service = new SimpleEmbeddingService({
    streamingWorkerUrl: resolveEmbeddingWorkerUrlHref(),
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
    fatalErrorRef,
    gate,
    queryEmbeddingActiveCountRef,
    request,
    runtimeIdRef,
    serviceStateRef,
  } = options;

  queryEmbeddingActiveCountRef.current += 1;
  reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'running', { active: true });
  try {
    if (fatalErrorRef.current) {
      throw new Error(fatalErrorRef.current);
    }
    if (request.runtimeId !== runtimeIdRef.current) {
      throw new Error('Embedding host query request targeted a stale runtime.');
    }
    const result = await runCoordinatedQueryEmbedding({
      gate,
      isWorkerActive: () => activeRef.current,
      drainTimeoutMs: QUERY_DRAIN_TIMEOUT_MS,
      onDrainTimeout: () => {
        logger.warn('Embedding host query proceeded before background drain completed', {
          requestId: request.requestId,
          runtimeId: request.runtimeId,
        });
      },
      generate: async () => {
        const service = await getQueryEmbeddingService(db, request, runtimeIdRef, serviceStateRef);
        const generated = await service.generateQueryEmbedding(request.payload.query);
        assertEmbeddingResultDimensions(request, generated);
        return generated;
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
    });
  }
}

function createActivityChangeHandler(
  runtimeIdRef: MutableRefObject<string>,
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
  readonly fatalErrorRef: MutableRefObject<string | null>;
  readonly gate: ForegroundEmbeddingGate;
  readonly isDisposed: () => boolean;
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
  fatalErrorRef,
  gate,
  isDisposed,
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
    const { devicePref: hydratedDevicePref } = await ensureVectorPreferencesHydrated({
      forceReload: true,
    });
    const workerConfig = createEmbeddingWorkerConfig(db, gate);
    const controller = await startEmbeddingWorker({
      ...workerConfig,
      device: hydratedDevicePref,
      embeddingCache: createEmbeddingCacheRepository(workerConfig.db),
      initializeLocalModelOnStart: false,
      onFatalError,
      onWorkerActivityChange,
      stopOnFatalLocalError: true,
      streamingWorkerUrl: resolveEmbeddingWorkerUrlHref(),
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
    const fatalError = fatalErrorRef.current;
    reportEmbeddingHostRuntimeStatus(runtimeIdRef, fatalError ? 'error' : 'running', {
      active: fatalError ? false : activeRef.current,
      lastError: fatalError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start embedding host worker', {
      error: message,
      runtimeId: runtimeIdRef.current,
    });
    fatalErrorRef.current = message;
    reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
      lastError: message,
    });
  } finally {
    startingRef.current = false;
  }
}

export function EmbeddingHostRuntime(): null {
  const db = usePGliteDatabase();
  const controllerRef = useRef<EmbeddingWorkerController | null>(null);
  const fatalErrorRef = useRef<string | null>(null);
  const startingRef = useRef(false);
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
    const onFatalError = createFatalErrorHandler(runtimeIdRef, fatalErrorRef, activeRef);
    const onWorkerActivityChange = createActivityChangeHandler(
      runtimeIdRef,
      fatalErrorRef,
      activeRef
    );

    const startWorker = async (): Promise<void> =>
      startEmbeddingHostWorkerRuntime({
        activeRef,
        controllerRef,
        db,
        fatalErrorRef,
        gate: gateRef.current,
        isDisposed: () => disposed,
        onFatalError,
        onWorkerActivityChange,
        runtimeIdRef,
        startingRef,
        stopPromiseRef,
      });

    const stopWorker = (
      reason: 'command-reset' | 'command-stop' | 'dispose' | 'post-start-dispose',
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
        reportEmbeddingHostRuntimeStatusForRuntimeId(reportRuntimeId, 'stopped');
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
        void stopWorker('command-stop');
        return;
      }
      if (nextCommand.payload.action === 'reset') {
        if (nextCommand.payload.nextRuntimeId === runtimeIdRef.current) {
          throw new Error('Embedding host reset requires a fresh nextRuntimeId.');
        }
        void resetWorker(nextCommand.payload.nextRuntimeId);
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

    void startWorker();

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
      runEmbeddingHostCleanupStep(
        runtimeIdRef,
        'Embedding host power channel cleanup failed',
        () => {
          channel?.close();
        }
      );
      void stopWorker('dispose');
    };
  }, [db]);

  return null;
}
