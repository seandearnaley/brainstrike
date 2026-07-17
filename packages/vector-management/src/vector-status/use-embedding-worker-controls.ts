import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { useCallback, useEffect, useState } from 'react';
import type {
  EmbeddingRuntimeController,
  EmbeddingRuntimeStatus,
} from './embedding-runtime-controller';
import { dispatchQueueDrainedEvent } from './queue-events';

export interface UseEmbeddingWorkerControlsParams {
  activeEmbeddingSetId: string | null;
  controller: EmbeddingRuntimeController;
  onBackfill: () => Promise<void>;
  toast: (options: { title: string; description?: string; variant?: 'destructive' }) => void;
}

export interface UseEmbeddingWorkerControlsResult {
  clearWorkerError: () => void;
  resetWorker: () => Promise<void>;
  startingWorker: boolean;
  startWorker: () => Promise<void>;
  startWorkerError: string | null;
  stopWorker: () => Promise<void>;
  workerLocalRunning: boolean;
  workerStatus?: EmbeddingRuntimeStatus | null;
}

function applyHostStatus(
  status: EmbeddingRuntimeStatus,
  setters: {
    setStartWorkerError: (value: string | null) => void;
    setStartingWorker: (value: boolean) => void;
    setWorkerLocalRunning: (value: boolean) => void;
  }
): void {
  setters.setStartingWorker(status.state === 'starting' || status.state === 'stopping');
  setters.setWorkerLocalRunning(status.state === 'running');
  setters.setStartWorkerError(
    status.state === 'error' ? (status.lastError ?? 'Embedding host failed.') : null
  );
}

function syncEmbeddingActivityFromHost(
  status: EmbeddingRuntimeStatus,
  setIsEmbeddingQueueActive: (active: boolean) => void
): void {
  if (status.active) {
    setIsEmbeddingQueueActive(true);
    return;
  }

  if (status.state === 'error' || status.state === 'stopped' || status.state === 'stopping') {
    setIsEmbeddingQueueActive(false);
  }
}

export function useEmbeddingWorkerControls(
  params: UseEmbeddingWorkerControlsParams
): UseEmbeddingWorkerControlsResult {
  const {
    controller,
    // These parameters are retained for API compatibility but currently unused
    // since auto-backfill on worker start is disabled
    activeEmbeddingSetId: _activeEmbeddingSetId,
    onBackfill: _onBackfill,
    toast,
  } = params;

  const [workerLocalRunning, setWorkerLocalRunning] = useState(false);
  const [startingWorker, setStartingWorker] = useState(false);
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null);
  const [workerStatus, setWorkerStatus] = useState<EmbeddingRuntimeStatus | null>(null);
  const setIsEmbeddingQueueActive = useVectorStatusUIStore((s) => s.setIsEmbeddingQueueActive);

  const clearWorkerError = useCallback(() => setStartWorkerError(null), []);

  useEffect(() => {
    const syncStatus = (status: EmbeddingRuntimeStatus) => {
      setWorkerStatus(status);
      applyHostStatus(status, {
        setStartingWorker,
        setStartWorkerError,
        setWorkerLocalRunning,
      });
      syncEmbeddingActivityFromHost(status, setIsEmbeddingQueueActive);
    };

    void controller
      .getStatus()
      .then(syncStatus)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setStartWorkerError(message);
      });

    return controller.onStatus(syncStatus);
  }, [controller, setIsEmbeddingQueueActive]);

  const launchWorker = useCallback(
    async (successToast: { title: string; description: string }) => {
      const status = await controller.start();
      setWorkerStatus(status);
      applyHostStatus(status, {
        setStartingWorker,
        setStartWorkerError,
        setWorkerLocalRunning,
      });
      syncEmbeddingActivityFromHost(status, setIsEmbeddingQueueActive);
      if (status.state === 'error') {
        throw new Error(status.lastError ?? 'Embedding runtime failed to start.');
      }
      dispatchQueueDrainedEvent();
      toast(successToast);
    },
    [controller, setIsEmbeddingQueueActive, toast]
  );

  const startWorker = useCallback(async () => {
    if (startingWorker) {
      return;
    }
    setStartingWorker(true);
    setStartWorkerError(null);
    try {
      await launchWorker({
        description: 'Local embedding worker is running.',
        title: 'Worker started',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStartWorkerError(message);
      toast({ description: message, title: 'Failed to start worker', variant: 'destructive' });
      throw error;
    } finally {
      setStartingWorker(false);
    }
  }, [startingWorker, launchWorker, toast]);

  const stopWorker = useCallback(async () => {
    try {
      const status = await controller.stop();
      setWorkerStatus(status);
      applyHostStatus(status, {
        setStartingWorker,
        setStartWorkerError,
        setWorkerLocalRunning,
      });
      syncEmbeddingActivityFromHost(status, setIsEmbeddingQueueActive);
      toast({ title: 'Worker stopped' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStartWorkerError(message);
      toast({ description: message, title: 'Failed to stop worker', variant: 'destructive' });
    }
  }, [controller, setIsEmbeddingQueueActive, toast]);

  const resetWorker = useCallback(async () => {
    setStartWorkerError(null);
    setStartingWorker(true);
    try {
      const status = await controller.reset();
      setWorkerStatus(status);
      applyHostStatus(status, {
        setStartingWorker,
        setStartWorkerError,
        setWorkerLocalRunning,
      });
      syncEmbeddingActivityFromHost(status, setIsEmbeddingQueueActive);
      if (status.state === 'error') {
        throw new Error(status.lastError ?? 'Embedding runtime failed to reset.');
      }
      dispatchQueueDrainedEvent();
      toast({
        description: 'Embedding worker restarted successfully.',
        title: 'Worker reset',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStartWorkerError(message);
      toast({ description: message, title: 'Worker reset failed', variant: 'destructive' });
    } finally {
      setStartingWorker(false);
    }
  }, [controller, setIsEmbeddingQueueActive, toast]);

  return {
    clearWorkerError,
    resetWorker,
    startingWorker,
    startWorker,
    startWorkerError,
    stopWorker,
    workerLocalRunning,
    workerStatus,
  };
}
