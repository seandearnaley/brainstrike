import { usePGliteDatabase } from '@brainstrike/db';
import {
  type EmbeddingWorkerController,
  POWER_BROADCAST_CHANNEL,
  startEmbeddingWorker,
} from '@brainstrike/embeddings';
import { ensureVectorPreferencesHydrated } from '@brainstrike/preferences';
import { createLogger } from '@brainstrike/utils';
import { type MutableRefObject, useEffect, useRef } from 'react';
import {
  assertEmbeddingHostCommand,
  type EmbeddingHostCommand,
  type EmbeddingHostStatus,
} from '../../embedding-host-shared';
import { createEmbeddingWorkerConfig } from './embedding-worker-config';

const logger = createLogger('EmbeddingHostRuntime');

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
    const { devicePref: hydratedDevicePref } = await ensureVectorPreferencesHydrated({
      forceReload: true,
    });
    const controller = await startEmbeddingWorker({
      ...createEmbeddingWorkerConfig(db),
      device: hydratedDevicePref,
      initializeLocalModelOnStart: false,
      onFatalError,
      onWorkerActivityChange,
      stopOnFatalLocalError: true,
    });
    if (isDisposed()) {
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

    const stopWorker = (): Promise<void> => {
      if (stopPromiseRef.current) {
        return stopPromiseRef.current;
      }

      const stopPromise = (async () => {
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
        reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'stopped');
      })();

      const trackedStopPromise = stopPromise.finally(() => {
        if (stopPromiseRef.current === trackedStopPromise) {
          stopPromiseRef.current = null;
        }
      });
      stopPromiseRef.current = trackedStopPromise;
      return trackedStopPromise;
    };

    const resetWorker = async (): Promise<void> => {
      await stopWorker();
      await startWorker();
    };

    const unsubscribeCommand = getEmbeddingHostBridge()?.onCommand?.((command) => {
      const nextCommand = assertEmbeddingHostCommand(command);
      if (nextCommand.payload.action === 'stop') {
        void stopWorker();
        return;
      }
      if (nextCommand.payload.action === 'reset') {
        void resetWorker();
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
      cleanupPower?.();
      unsubscribeCommand?.();
      channel?.close();
      void stopWorker();
    };
  }, [db]);

  return null;
}
