import type { EmbeddingWorkerController, EmbeddingWorkerOptions } from '@brainstrike/embeddings';
import { startEmbeddingWorker } from '@brainstrike/embeddings';
import { useCallback, useRef, useState } from 'react';

export interface UseEmbeddingWorkerControlsParams {
  activeEmbeddingSetId: string | null;
  db: EmbeddingWorkerOptions['db'] | null;
  devicePreference: 'webgpu' | 'wasm';
  onBackfill: () => Promise<void>;
  reinitEveryN: number;
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

export function useEmbeddingWorkerControls(
  params: UseEmbeddingWorkerControlsParams
): UseEmbeddingWorkerControlsResult {
  const {
    db,
    devicePreference,
    reinitEveryN,
    // These parameters are retained for API compatibility but currently unused
    // since auto-backfill on worker start is disabled
    activeEmbeddingSetId: _activeEmbeddingSetId,
    onBackfill: _onBackfill,
    toast,
  } = params;

  const workerControllerRef = useRef<EmbeddingWorkerController | null>(null);
  const [workerLocalRunning, setWorkerLocalRunning] = useState(false);
  const [startingWorker, setStartingWorker] = useState(false);
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null);

  const clearWorkerError = useCallback(() => setStartWorkerError(null), []);

  const launchWorker = useCallback(
    async (successToast: { title: string; description: string }) => {
      if (!db) {
        return;
      }
      const options: EmbeddingWorkerOptions = {
        db,
        enable: true,
        reinitEveryN,
        device: devicePreference,
      };
      const controller = await startEmbeddingWorker(options);
      workerControllerRef.current = controller;
      setWorkerLocalRunning(true);
      dispatchQueueDrainedEvent();
      // Auto-backfill on worker start is disabled - backfill must be triggered manually
      // via the Backfill button in Vector Status. This gives users explicit control
      // over when embedding jobs are enqueued.
      toast(successToast);
    },
    [db, devicePreference, reinitEveryN, toast]
  );

  const startWorker = useCallback(async () => {
    if (!db || startingWorker) {
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
  }, [db, startingWorker, launchWorker, toast]);

  const stopWorker = useCallback(async () => {
    try {
      await workerControllerRef.current?.stop();
    } finally {
      workerControllerRef.current = null;
      setWorkerLocalRunning(false);
      toast({ title: 'Worker stopped' });
    }
  }, [toast]);

  const resetWorker = useCallback(async () => {
    if (!db) {
      return;
    }
    setStartWorkerError(null);
    setStartingWorker(true);
    try {
      if (workerLocalRunning) {
        await workerControllerRef.current?.stop();
      }
      workerControllerRef.current = null;
      setWorkerLocalRunning(false);
      await launchWorker({
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
  }, [db, workerLocalRunning, launchWorker, toast]);

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
