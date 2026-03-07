import { usePGliteDatabase } from '@brainstrike/db';
import {
  type EmbeddingWorkerController,
  POWER_BROADCAST_CHANNEL,
  startEmbeddingWorker,
} from '@brainstrike/embeddings';
import { createLogger } from '@brainstrike/utils';
import { useEffect, useRef } from 'react';
import type { EmbeddingHostCommand, EmbeddingHostStatus } from '../../embedding-host-shared';
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

export function EmbeddingHostRuntime(): null {
  const db = usePGliteDatabase();
  const controllerRef = useRef<EmbeddingWorkerController | null>(null);
  const startingRef = useRef(false);
  const activeRef = useRef(false);

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
      reportStatus({ state: 'starting', active: false, lastError: null });

      try {
        const controller = await startEmbeddingWorker({
          ...createEmbeddingWorkerConfig(db),
          initializeLocalModelOnStart: false,
          onWorkerActivityChange: (active: boolean) => {
            activeRef.current = active;
            reportStatus({
              state: 'running',
              active,
              lastError: null,
            });
          },
        });
        if (disposed) {
          await controller.stop();
          return;
        }
        controllerRef.current = controller;
        reportStatus({ state: 'running', active: activeRef.current, lastError: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to start embedding host worker', { error: message });
        reportStatus({ state: 'error', active: false, lastError: message });
      } finally {
        startingRef.current = false;
      }
    };

    const stopWorker = async (): Promise<void> => {
      const controller = controllerRef.current;
      controllerRef.current = null;
      activeRef.current = false;
      if (controller) {
        await controller.stop();
      }
      reportStatus({ state: 'stopped', active: false, lastError: null });
    };

    const resetWorker = async (): Promise<void> => {
      await stopWorker();
      await startWorker();
    };

    const unsubscribeCommand = getEmbeddingHostBridge()?.onCommand?.((command) => {
      if (command.type === 'stop') {
        void stopWorker();
        return;
      }
      if (command.type === 'reset') {
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
