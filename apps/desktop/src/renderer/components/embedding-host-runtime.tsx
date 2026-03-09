import { usePGliteDatabase } from '@brainstrike/db';
import {
  type EmbeddingWorkerController,
  POWER_BROADCAST_CHANNEL,
  startEmbeddingWorker,
} from '@brainstrike/embeddings';
import { ensureVectorPreferencesHydrated } from '@brainstrike/preferences';
import { createLogger } from '@brainstrike/utils';
import { useEffect, useRef } from 'react';
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

function resolveEmbeddingHostRuntimeId(): string {
  const runtimeId = new URLSearchParams(window.location.search).get('runtimeId');
  if (!(runtimeId && runtimeId.trim().length > 0)) {
    throw new Error('Embedding host renderer requires a runtimeId query parameter.');
  }
  return runtimeId;
}

export function EmbeddingHostRuntime(): null {
  const db = usePGliteDatabase();
  const controllerRef = useRef<EmbeddingWorkerController | null>(null);
  const fatalErrorRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const activeRef = useRef(false);
  const runtimeIdRef = useRef<string>(resolveEmbeddingHostRuntimeId());

  useEffect(() => {
    if (!db) {
      return;
    }

    let disposed = false;

    const startWorker = async (): Promise<void> => {
      if (disposed || startingRef.current || controllerRef.current) {
        return;
      }

      startingRef.current = true;
      fatalErrorRef.current = null;
      reportStatus({
        runtimeKind: 'embedding-host',
        runtimeId: runtimeIdRef.current,
        state: 'starting',
        active: false,
        lastError: null,
      });

      try {
        const { devicePref: hydratedDevicePref } = await ensureVectorPreferencesHydrated({
          forceReload: true,
        });
        const controller = await startEmbeddingWorker({
          ...createEmbeddingWorkerConfig(db),
          device: hydratedDevicePref,
          initializeLocalModelOnStart: false,
          onFatalError: (error: Error) => {
            const message = error.message;
            fatalErrorRef.current = message;
            activeRef.current = false;
            logger.error('Embedding host worker stopped after fatal local model error', {
              error: message,
              runtimeId: runtimeIdRef.current,
            });
            reportStatus({
              runtimeKind: 'embedding-host',
              runtimeId: runtimeIdRef.current,
              state: 'error',
              active: false,
              lastError: message,
            });
          },
          onWorkerActivityChange: (active: boolean) => {
            if (fatalErrorRef.current) {
              return;
            }
            activeRef.current = active;
            reportStatus({
              runtimeKind: 'embedding-host',
              runtimeId: runtimeIdRef.current,
              state: 'running',
              active,
              lastError: null,
            });
          },
          stopOnFatalLocalError: true,
        });
        if (disposed) {
          await controller.stop();
          return;
        }
        controllerRef.current = controller;
        if (fatalErrorRef.current) {
          reportStatus({
            runtimeKind: 'embedding-host',
            runtimeId: runtimeIdRef.current,
            state: 'error',
            active: false,
            lastError: fatalErrorRef.current,
          });
          return;
        }
        reportStatus({
          runtimeKind: 'embedding-host',
          runtimeId: runtimeIdRef.current,
          state: 'running',
          active: activeRef.current,
          lastError: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to start embedding host worker', {
          error: message,
          runtimeId: runtimeIdRef.current,
        });
        fatalErrorRef.current = message;
        reportStatus({
          runtimeKind: 'embedding-host',
          runtimeId: runtimeIdRef.current,
          state: 'error',
          active: false,
          lastError: message,
        });
      } finally {
        startingRef.current = false;
      }
    };

    const stopWorker = async (): Promise<void> => {
      const controller = controllerRef.current;
      controllerRef.current = null;
      fatalErrorRef.current = null;
      activeRef.current = false;
      if (controller) {
        await controller.stop();
      }
      reportStatus({
        runtimeKind: 'embedding-host',
        runtimeId: runtimeIdRef.current,
        state: 'stopped',
        active: false,
        lastError: null,
      });
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
