import { createEmbeddingCacheRepository, createPriorityDbHandle } from '@brainstrike/db';
import { getRegisteredEmbeddingRuntimeConfig } from '@brainstrike/embeddings/runtime-config';
import type {
  EmbeddingWorkerController,
  EmbeddingWorkerOptions,
} from '@brainstrike/embeddings/worker';
import {
  type BackgroundRuntimeProgress,
  type BackgroundRuntimeStatus,
  createBackgroundRuntimeStatus,
  createRequestId,
  createRuntimeId,
  createRuntimeStatusStore,
} from '@brainstrike/worker-runtime';
import { useEffect, useMemo, useRef } from 'react';
import type { VectorQueueService } from './vector-queue-service';

export type EmbeddingRuntimeBackfillSource = 'background-indexing' | 'manual';

export interface EmbeddingRuntimeBackfillProgress extends BackgroundRuntimeProgress {
  readonly embeddingSetId: string;
  readonly source: EmbeddingRuntimeBackfillSource;
}

export interface EmbeddingRuntimeBackfillInfo {
  readonly embeddingSetId: string;
  readonly progress: { current: number; total: number } | null;
  readonly requestId: string;
  readonly source: EmbeddingRuntimeBackfillSource;
}

export interface EmbeddingHostRuntimeMetadata {
  readonly actualWorkerMetadata: {
    readonly device: 'webgpu' | 'wasm';
    readonly dtype: string;
    readonly fallbackApplied: boolean;
  } | null;
  readonly backendMismatch: boolean;
  readonly selectedDevicePreference: 'webgpu' | 'wasm';
}

export type EmbeddingRuntimeStatus = BackgroundRuntimeStatus<
  'embedding-host' | 'embedding-worker'
> & {
  readonly embeddingRuntime?: EmbeddingHostRuntimeMetadata;
};

/**
 * Result of enqueueBackfill. `{ canceled: true }` is returned (desktop only) when
 * the backfill was deliberately canceled before it started — desktop main resolves
 * this instead of rejecting the IPC call (a rejection logs "Error occurred in
 * handler"). The local/web runtime always returns `{ requestId }`.
 */
export type EnqueueBackfillResult = { requestId: string } | { canceled: true };

export interface EmbeddingRuntimeController {
  cancelAllBackfills: () => Promise<void>;
  cancelBackfill: (embeddingSetId: string) => Promise<void>;
  enqueueBackfill: (
    embeddingSetId: string,
    options?: { signal?: AbortSignal; source?: EmbeddingRuntimeBackfillSource }
  ) => Promise<EnqueueBackfillResult>;
  ensureStarted: () => Promise<EmbeddingRuntimeStatus>;
  getBackfillsInFlight: () => Promise<EmbeddingRuntimeBackfillInfo[]>;
  getStatus: () => Promise<EmbeddingRuntimeStatus>;
  onBackfillProgress: (
    callback: (progress: EmbeddingRuntimeBackfillProgress) => void
  ) => () => void;
  onStatus: (callback: (status: EmbeddingRuntimeStatus) => void) => () => void;
  reset: () => Promise<EmbeddingRuntimeStatus>;
  start: () => Promise<EmbeddingRuntimeStatus>;
  stop: () => Promise<EmbeddingRuntimeStatus>;
}

interface EmbeddingHostStatus {
  readonly active: boolean;
  readonly commandId?: string;
  readonly embeddingRuntime?: EmbeddingHostRuntimeMetadata;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly runtimeKind: 'embedding-host';
  readonly state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

/** Stop correlation belongs to the host protocol, not the canonical UI status.
 * Keep every other field so the status store still rejects unknown extensions. */
/** The only fields beyond the canonical runtime status a desktop embedding-host status carries. */
export const EMBEDDING_RUNTIME_STATUS_EXTENSION_KEYS: readonly string[] = ['embeddingRuntime'];

function projectDesktopRuntimeStatus(status: EmbeddingHostStatus): EmbeddingRuntimeStatus {
  const runtimeStatus = { ...status };
  Reflect.deleteProperty(runtimeStatus, 'commandId');
  return runtimeStatus;
}

export interface EmbeddingHostApi {
  readonly cancelAllBackfills?: () => Promise<void>;
  readonly cancelBackfill?: (embeddingSetId: string) => Promise<void>;
  readonly enqueueBackfill?: (request: {
    embeddingSetId: string;
    source?: EmbeddingRuntimeBackfillSource;
  }) => Promise<EnqueueBackfillResult>;
  readonly ensureStarted: () => Promise<EmbeddingHostStatus>;
  readonly getBackfillsInFlight?: () => Promise<EmbeddingRuntimeBackfillInfo[]>;
  readonly getStatus: () => Promise<EmbeddingHostStatus>;
  readonly onBackfillProgress?: (
    callback: (progress: EmbeddingRuntimeBackfillProgress) => void
  ) => () => void;
  readonly onStatus: (callback: (status: EmbeddingHostStatus) => void) => () => void;
  readonly reset: () => Promise<EmbeddingHostStatus>;
  readonly stop: () => Promise<EmbeddingHostStatus>;
}

interface LocalBackfillState {
  readonly abortController: AbortController;
  progress: { current: number; total: number } | null;
  readonly requestId: string;
  readonly source: EmbeddingRuntimeBackfillSource;
}

interface UseEmbeddingRuntimeControllerParams {
  readonly db: EmbeddingWorkerOptions['db'] | null;
  readonly devicePreference: 'wasm' | 'webgpu';
  readonly reinitEveryN: number;
  readonly service: VectorQueueService | null;
}

const BACKGROUND_INDEXING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS = 10 * 60 * 1000;

function isEmbeddingHostApi(value: unknown): value is EmbeddingHostApi {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Partial<EmbeddingHostApi>;
  return (
    typeof candidate.ensureStarted === 'function' &&
    typeof candidate.getStatus === 'function' &&
    typeof candidate.onStatus === 'function' &&
    typeof candidate.reset === 'function' &&
    typeof candidate.stop === 'function'
  );
}

export function getEmbeddingHostApi(): EmbeddingHostApi | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as Window & { embeddingHost?: unknown }).embeddingHost;
  return isEmbeddingHostApi(candidate) ? candidate : null;
}

export function hasEmbeddingBackfillCapability(): boolean {
  const embeddingHost = getEmbeddingHostApi();
  return Boolean(
    embeddingHost &&
      typeof embeddingHost.getBackfillsInFlight === 'function' &&
      typeof embeddingHost.onBackfillProgress === 'function'
  );
}

function createStoppedLocalStatus(runtimeId: string): EmbeddingRuntimeStatus {
  return createBackgroundRuntimeStatus('embedding-worker', runtimeId, 'stopped');
}

function createBackfillRequestId(source: EmbeddingRuntimeBackfillSource): string {
  return createRequestId(
    source === 'background-indexing' ? 'background-indexing-backfill' : 'embedding-backfill'
  );
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function mergeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const filteredSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (filteredSignals.length === 0) {
    return;
  }
  if (filteredSignals.length === 1) {
    return filteredSignals[0];
  }
  const controller = new AbortController();
  const abort = (): void => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort();
    for (const signal of filteredSignals) {
      signal.removeEventListener('abort', abort);
    }
  };
  for (const signal of filteredSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

async function enqueueLocalBackfill(args: {
  embeddingSetId: string;
  localBackfills: Map<string, LocalBackfillState>;
  notifyBackfillProgress: (progress: EmbeddingRuntimeBackfillProgress) => void;
  options?: { signal?: AbortSignal; source?: EmbeddingRuntimeBackfillSource };
  service: VectorQueueService;
}): Promise<{ requestId: string }> {
  if (args.localBackfills.has(args.embeddingSetId)) {
    throw new Error(`Embedding backfill is already running for set ${args.embeddingSetId}.`);
  }

  const source = args.options?.source ?? 'manual';
  const requestId = createBackfillRequestId(source);
  const backfillAbortController = new AbortController();
  const signal = mergeAbortSignals([args.options?.signal, backfillAbortController.signal]);
  args.localBackfills.set(args.embeddingSetId, {
    abortController: backfillAbortController,
    progress: null,
    requestId,
    source,
  });

  try {
    await args.service.backfill(args.embeddingSetId, {
      onProgress: (done, total) => {
        const backfill = args.localBackfills.get(args.embeddingSetId);
        if (!backfill || backfill.requestId !== requestId) {
          return;
        }
        backfill.progress = { current: done, total };
        args.notifyBackfillProgress({
          current: done,
          embeddingSetId: args.embeddingSetId,
          requestId,
          source,
          stage: 'backfill',
          total,
        });
      },
      ...(source === 'background-indexing'
        ? {
            queueCapacityTimeoutMs: BACKGROUND_INDEXING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS,
          }
        : {}),
      ...(signal ? { signal } : {}),
    });
    const backfill = args.localBackfills.get(args.embeddingSetId);
    args.notifyBackfillProgress({
      current: backfill?.progress?.current ?? 0,
      embeddingSetId: args.embeddingSetId,
      requestId,
      source,
      stage: 'complete',
      total: backfill?.progress?.total ?? 0,
    });
    return { requestId };
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError('Embedding backfill was canceled.');
    }
    const message = error instanceof Error ? error.message : String(error);
    const backfill = args.localBackfills.get(args.embeddingSetId);
    args.notifyBackfillProgress({
      current: backfill?.progress?.current ?? 0,
      embeddingSetId: args.embeddingSetId,
      message,
      requestId,
      source,
      stage: 'error',
      total: backfill?.progress?.total ?? 0,
    });
    throw error;
  } finally {
    const backfill = args.localBackfills.get(args.embeddingSetId);
    if (backfill?.requestId === requestId) {
      args.localBackfills.delete(args.embeddingSetId);
    }
  }
}

function getRequiredEmbeddingRuntimeConfig(): { readonly streamingWorkerUrl: string } {
  const config = getRegisteredEmbeddingRuntimeConfig();
  if (!config) {
    throw new Error(
      'Embedding runtime config is not registered. Register an explicit streamingWorkerUrl before starting the local embedding worker.'
    );
  }
  return config;
}

async function loadStartEmbeddingWorker(): Promise<
  typeof import('@brainstrike/embeddings/worker').startEmbeddingWorker
> {
  const module = await import('@brainstrike/embeddings/worker');
  return module.startEmbeddingWorker;
}

export function useEmbeddingRuntimeController(
  params: UseEmbeddingRuntimeControllerParams
): EmbeddingRuntimeController {
  const { db, devicePreference, reinitEveryN, service } = params;
  const desktopHost = getEmbeddingHostApi();
  const localRuntimeIdRef = useRef<string>(createRuntimeId('embedding-worker'));
  const localWorkerControllerRef = useRef<EmbeddingWorkerController | null>(null);
  const statusStoreRef = useRef(
    createRuntimeStatusStore<EmbeddingRuntimeStatus>(
      desktopHost
        ? createBackgroundRuntimeStatus('embedding-host', 'embedding-host:stopped', 'stopped')
        : createStoppedLocalStatus(localRuntimeIdRef.current),
      { allowedExtensionKeys: EMBEDDING_RUNTIME_STATUS_EXTENSION_KEYS }
    )
  );
  const backfillListenersRef = useRef(
    new Set<(progress: EmbeddingRuntimeBackfillProgress) => void>()
  );
  const localBackfillsRef = useRef(new Map<string, LocalBackfillState>());

  useEffect(() => {
    if (!desktopHost) {
      return;
    }

    let disposed = false;
    void desktopHost.getStatus().then((status) => {
      if (disposed) {
        return;
      }
      statusStoreRef.current.setStatus(projectDesktopRuntimeStatus(status));
    });

    const cleanupStatus = desktopHost.onStatus((status) => {
      if (disposed) {
        return;
      }
      statusStoreRef.current.setStatus(projectDesktopRuntimeStatus(status));
    });

    const cleanupBackfill = desktopHost.onBackfillProgress?.((progress) => {
      if (disposed) {
        return;
      }
      for (const listener of backfillListenersRef.current) {
        listener(progress);
      }
    });

    return () => {
      disposed = true;
      cleanupStatus();
      cleanupBackfill?.();
    };
  }, [desktopHost]);

  const controller = useMemo<EmbeddingRuntimeController>(() => {
    const notifyBackfillProgress = (progress: EmbeddingRuntimeBackfillProgress): void => {
      for (const listener of backfillListenersRef.current) {
        listener(progress);
      }
    };

    const updateLocalStatus = (status: EmbeddingRuntimeStatus): EmbeddingRuntimeStatus =>
      statusStoreRef.current.setStatus(status);

    const ensureDesktopHostStarted = async (): Promise<EmbeddingRuntimeStatus> => {
      if (!desktopHost) {
        throw new Error('Desktop embedding host bridge is unavailable.');
      }
      const status = await desktopHost.ensureStarted();
      return statusStoreRef.current.setStatus(projectDesktopRuntimeStatus(status));
    };

    const ensureLocalStarted = async (): Promise<EmbeddingRuntimeStatus> => {
      const current = statusStoreRef.current.getStatus();
      if (localWorkerControllerRef.current) {
        return current;
      }
      if (!db) {
        throw new Error('Database is required to start the local embedding worker.');
      }
      const runtimeConfig = getRequiredEmbeddingRuntimeConfig();

      updateLocalStatus(
        createBackgroundRuntimeStatus('embedding-worker', localRuntimeIdRef.current, 'starting')
      );

      try {
        const startEmbeddingWorker = await loadStartEmbeddingWorker();
        // Same content-level dedup the desktop embedding host gets (#928).
        // Without this, the in-tab (web) worker silently re-embeds
        // byte-identical content on every pass — the cache table exists on
        // both platforms, so wire it on both.
        const backgroundDb = createPriorityDbHandle(db, 'background');
        const controller = await startEmbeddingWorker({
          db: backgroundDb,
          device: devicePreference,
          embeddingCache: createEmbeddingCacheRepository(backgroundDb),
          enable: true,
          onFatalError: (error: Error) => {
            updateLocalStatus(
              createBackgroundRuntimeStatus(
                'embedding-worker',
                localRuntimeIdRef.current,
                'error',
                {
                  lastError: error.message,
                }
              )
            );
          },
          onWorkerActivityChange: (active: boolean) => {
            updateLocalStatus(
              createBackgroundRuntimeStatus(
                'embedding-worker',
                localRuntimeIdRef.current,
                'running',
                {
                  active,
                }
              )
            );
          },
          reinitEveryN,
          streamingWorkerUrl: runtimeConfig.streamingWorkerUrl,
        });
        localWorkerControllerRef.current = controller;
        return updateLocalStatus(
          createBackgroundRuntimeStatus('embedding-worker', localRuntimeIdRef.current, 'running')
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return updateLocalStatus(
          createBackgroundRuntimeStatus('embedding-worker', localRuntimeIdRef.current, 'error', {
            lastError: message,
          })
        );
      }
    };

    return {
      cancelAllBackfills: async () => {
        if (desktopHost?.cancelAllBackfills) {
          await desktopHost.cancelAllBackfills();
          return;
        }
        for (const backfill of localBackfillsRef.current.values()) {
          backfill.abortController.abort();
        }
      },
      cancelBackfill: async (embeddingSetId: string) => {
        if (desktopHost?.cancelBackfill) {
          await desktopHost.cancelBackfill(embeddingSetId);
          return;
        }
        const backfill = localBackfillsRef.current.get(embeddingSetId);
        if (!backfill) {
          return;
        }
        backfill.abortController.abort();
      },
      enqueueBackfill: async (
        embeddingSetId: string,
        options?: { signal?: AbortSignal; source?: EmbeddingRuntimeBackfillSource }
      ): Promise<EnqueueBackfillResult> => {
        const source = options?.source ?? 'manual';
        if (desktopHost?.enqueueBackfill) {
          const status = await ensureDesktopHostStarted();
          if (status.state === 'error') {
            throw new Error(status.lastError ?? 'Embedding runtime failed to apply host settings.');
          }
          return await desktopHost.enqueueBackfill({
            embeddingSetId,
            source,
          });
        }
        if (!service) {
          throw new Error('Embedding runtime backfill requires a vector queue service.');
        }
        return await enqueueLocalBackfill({
          embeddingSetId,
          localBackfills: localBackfillsRef.current,
          notifyBackfillProgress,
          service,
          ...(options ? { options } : {}),
        });
      },
      ensureStarted: async () => {
        if (desktopHost) {
          return ensureDesktopHostStarted();
        }
        return ensureLocalStarted();
      },
      getBackfillsInFlight: async () => {
        if (desktopHost?.getBackfillsInFlight) {
          return desktopHost.getBackfillsInFlight();
        }
        return Array.from(localBackfillsRef.current.entries()).map(
          ([embeddingSetId, backfill]) => ({
            embeddingSetId,
            progress: backfill.progress,
            requestId: backfill.requestId,
            source: backfill.source,
          })
        );
      },
      getStatus: async () => {
        if (desktopHost) {
          const status = await desktopHost.getStatus();
          return statusStoreRef.current.setStatus(projectDesktopRuntimeStatus(status));
        }
        return statusStoreRef.current.getStatus();
      },
      onBackfillProgress: (callback) => {
        backfillListenersRef.current.add(callback);
        return () => {
          backfillListenersRef.current.delete(callback);
        };
      },
      onStatus: (callback) => statusStoreRef.current.subscribe(callback),
      reset: async () => {
        if (desktopHost) {
          const status = await desktopHost.reset();
          return statusStoreRef.current.setStatus(projectDesktopRuntimeStatus(status));
        }
        if (localWorkerControllerRef.current) {
          await localWorkerControllerRef.current.stop();
          localWorkerControllerRef.current = null;
        }
        localRuntimeIdRef.current = createRuntimeId('embedding-worker');
        updateLocalStatus(createStoppedLocalStatus(localRuntimeIdRef.current));
        return ensureLocalStarted();
      },
      start: async () => {
        if (desktopHost) {
          return ensureDesktopHostStarted();
        }
        return ensureLocalStarted();
      },
      stop: async () => {
        if (desktopHost) {
          const status = await desktopHost.stop();
          return statusStoreRef.current.setStatus(projectDesktopRuntimeStatus(status));
        }
        if (localWorkerControllerRef.current) {
          await localWorkerControllerRef.current.stop();
          localWorkerControllerRef.current = null;
        }
        return updateLocalStatus(createStoppedLocalStatus(localRuntimeIdRef.current));
      },
    };
  }, [db, desktopHost, devicePreference, reinitEveryN, service]);

  return controller;
}
