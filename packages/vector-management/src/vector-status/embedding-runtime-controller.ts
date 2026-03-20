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

export interface EmbeddingRuntimeBackfillProgress extends BackgroundRuntimeProgress {
  readonly embeddingSetId: string;
}

export type EmbeddingRuntimeStatus = BackgroundRuntimeStatus<'embedding-host' | 'embedding-worker'>;

export interface EmbeddingRuntimeController {
  cancelAllBackfills: () => Promise<void>;
  enqueueBackfill: (embeddingSetId: string) => Promise<void>;
  ensureStarted: () => Promise<EmbeddingRuntimeStatus>;
  getBackfillsInFlight: () => Promise<string[]>;
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
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly runtimeKind: 'embedding-host';
  readonly state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface EmbeddingHostApi {
  readonly cancelAllBackfills?: () => Promise<void>;
  readonly enqueueBackfill?: (embeddingSetId: string) => Promise<unknown>;
  readonly ensureStarted: () => Promise<EmbeddingHostStatus>;
  readonly getBackfillsInFlight?: () => Promise<string[]>;
  readonly getStatus: () => Promise<EmbeddingHostStatus>;
  readonly onBackfillProgress?: (
    callback: (progress: EmbeddingRuntimeBackfillProgress) => void
  ) => () => void;
  readonly onStatus: (callback: (status: EmbeddingHostStatus) => void) => () => void;
  readonly reset: () => Promise<EmbeddingHostStatus>;
  readonly stop: () => Promise<EmbeddingHostStatus>;
}

interface UseEmbeddingRuntimeControllerParams {
  readonly db: EmbeddingWorkerOptions['db'] | null;
  readonly devicePreference: 'wasm' | 'webgpu';
  readonly reinitEveryN: number;
  readonly service: VectorQueueService | null;
}

function getEmbeddingHostApi(): EmbeddingHostApi | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const currentWindow = window as Window & {
    electronAPI?: unknown;
    embeddingHost?: EmbeddingHostApi;
  };
  if (!currentWindow.electronAPI) {
    return null;
  }
  return currentWindow.embeddingHost ?? null;
}

function createStoppedLocalStatus(runtimeId: string): EmbeddingRuntimeStatus {
  return createBackgroundRuntimeStatus('embedding-worker', runtimeId, 'stopped');
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
        : createStoppedLocalStatus(localRuntimeIdRef.current)
    )
  );
  const backfillListenersRef = useRef(
    new Set<(progress: EmbeddingRuntimeBackfillProgress) => void>()
  );

  useEffect(() => {
    if (!desktopHost) {
      return;
    }

    let disposed = false;
    void desktopHost.getStatus().then((status) => {
      if (disposed) {
        return;
      }
      statusStoreRef.current.setStatus(status);
    });

    const cleanupStatus = desktopHost.onStatus((status) => {
      if (disposed) {
        return;
      }
      statusStoreRef.current.setStatus(status);
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
      return statusStoreRef.current.setStatus(status);
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
        const controller = await startEmbeddingWorker({
          db,
          enable: true,
          reinitEveryN,
          device: devicePreference,
          streamingWorkerUrl: runtimeConfig.streamingWorkerUrl,
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
        }
      },
      enqueueBackfill: async (embeddingSetId: string): Promise<void> => {
        if (desktopHost?.enqueueBackfill) {
          const status = await ensureDesktopHostStarted();
          if (status.state === 'error') {
            throw new Error(status.lastError ?? 'Embedding runtime failed to apply host settings.');
          }
          await desktopHost.enqueueBackfill(embeddingSetId);
          return;
        }
        if (!service) {
          throw new Error('Embedding runtime backfill requires a vector queue service.');
        }
        const requestId = createRequestId('embedding-backfill');
        await service.backfill(embeddingSetId, (done, total) => {
          notifyBackfillProgress({
            embeddingSetId,
            requestId,
            stage: 'backfill',
            current: done,
            total,
          });
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
        return [];
      },
      getStatus: async () => {
        if (desktopHost) {
          const status = await desktopHost.getStatus();
          return statusStoreRef.current.setStatus(status);
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
          return statusStoreRef.current.setStatus(status);
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
          return statusStoreRef.current.setStatus(status);
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
