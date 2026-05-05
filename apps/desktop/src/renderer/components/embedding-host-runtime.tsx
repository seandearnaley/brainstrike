import { createEmbeddingCacheRepository, usePGliteDatabase } from '@brainstrike/db';
import {
  type EmbeddingWorkerController,
  POWER_BROADCAST_CHANNEL,
  startEmbeddingWorker,
} from '@brainstrike/embeddings/worker';
import { ensureVectorPreferencesHydrated } from '@brainstrike/preferences/stores/vector-preferences-store';
import { createLogger } from '@brainstrike/utils/logger';
import { type MutableRefObject, useEffect, useRef } from 'react';
import {
  assertEmbeddingHostCommand,
  type EmbeddingHostCommand,
  type EmbeddingHostStatus,
} from '../../embedding-host-shared';
import { resolveEmbeddingWorkerUrlHref } from '../resolve-embedding-worker-url';
import { createEmbeddingWorkerConfig } from './embedding-worker-config';

const logger = createLogger('EmbeddingHostRuntime');
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
  reportStatus?: (status: EmbeddingHostStatus) => void;
} | null {
  const hostWindow = window as Window & {
    embeddingHost?: {
      onCommand?: (callback: (command: EmbeddingHostCommand) => void) => () => void;
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
    const workerConfig = createEmbeddingWorkerConfig(db);
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
        if (controller) {
          await controller.stop();
        }
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
