import { useVectorStatusUIStore } from '@brainstrike/preferences';
import { useCallback, useEffect, useState } from 'react';
import type {
  EmbeddingRuntimeController,
  EmbeddingRuntimeStatus,
} from './embedding-runtime-controller';

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
}

function dispatchQueueDrainedEvent(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.dispatchEvent(new CustomEvent('brainstrike:queue-drained'));
  } catch {
    // ignore dispatch failures
  }
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
  const setIsEmbeddingQueueActive = useVectorStatusUIStore((s) => s.setIsEmbeddingQueueActive);

  const clearWorkerError = useCallback(() => setStartWorkerError(null), []);

  useEffect(() => {
    const syncStatus = (status: EmbeddingRuntimeStatus) => {
      applyHostStatus(status, {
        setStartWorkerError,
        setStartingWorker,
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
      applyHostStatus(status, {
        setStartWorkerError,
        setStartingWorker,
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
        title: 'Worker started',
        description: 'Local embedding worker is running.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStartWorkerError(message);
      toast({ title: 'Failed to start worker', description: message, variant: 'destructive' });
    } finally {
      setStartingWorker(false);
    }
  }, [startingWorker, launchWorker, toast]);

  const stopWorker = useCallback(async () => {
    const status = await controller.stop();
    applyHostStatus(status, {
      setStartWorkerError,
      setStartingWorker,
      setWorkerLocalRunning,
    });
    syncEmbeddingActivityFromHost(status, setIsEmbeddingQueueActive);
    toast({ title: 'Worker stopped' });
  }, [controller, setIsEmbeddingQueueActive, toast]);

  const resetWorker = useCallback(async () => {
    setStartWorkerError(null);
    setStartingWorker(true);
    try {
      const status = await controller.reset();
      applyHostStatus(status, {
        setStartWorkerError,
        setStartingWorker,
        setWorkerLocalRunning,
      });
      syncEmbeddingActivityFromHost(status, setIsEmbeddingQueueActive);
      if (status.state === 'error') {
        throw new Error(status.lastError ?? 'Embedding runtime failed to reset.');
      }
      dispatchQueueDrainedEvent();
      toast({
        title: 'Worker reset',
        description: 'Embedding worker restarted successfully.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStartWorkerError(message);
      toast({ title: 'Worker reset failed', description: message, variant: 'destructive' });
    } finally {
      setStartingWorker(false);
    }
  }, [controller, setIsEmbeddingQueueActive, toast]);

  return {
    workerLocalRunning,
    startingWorker,
    startWorkerError,
    clearWorkerError,
    startWorker,
    stopWorker,
    resetWorker,
  };
}
