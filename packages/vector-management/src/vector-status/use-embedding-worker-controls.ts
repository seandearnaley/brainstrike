import type { EmbeddingWorkerController, EmbeddingWorkerOptions } from '@brainstrike/embeddings';
import { startEmbeddingWorker } from '@brainstrike/embeddings';
import { useCallback, useEffect, useRef, useState } from 'react';

interface EmbeddingHostStatus {
  active: boolean;
  lastError: string | null;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface EmbeddingHostApi {
  ensureStarted: () => Promise<EmbeddingHostStatus>;
  getStatus: () => Promise<EmbeddingHostStatus>;
  onStatus: (callback: (status: EmbeddingHostStatus) => void) => () => void;
  reset: () => Promise<EmbeddingHostStatus>;
  stop: () => Promise<EmbeddingHostStatus>;
}

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

function isElectronRendererWithHost(): boolean {
  const currentWindow = window as Window & {
    electronAPI?: unknown;
    embeddingHost?: EmbeddingHostApi;
  };
  return Boolean(currentWindow.electronAPI && currentWindow.embeddingHost);
}

function getEmbeddingHostApi(): EmbeddingHostApi {
  const currentWindow = window as Window & {
    embeddingHost?: EmbeddingHostApi;
  };
  const api = currentWindow.embeddingHost;
  if (!api) {
    throw new Error('Embedding host API is unavailable in this renderer.');
  }
  return api;
}

function applyHostStatus(
  status: EmbeddingHostStatus,
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
  const useEmbeddingHost = typeof window !== 'undefined' && isElectronRendererWithHost();

  const clearWorkerError = useCallback(() => setStartWorkerError(null), []);

  useEffect(() => {
    if (!useEmbeddingHost) {
      return;
    }

    const host = getEmbeddingHostApi();
    const syncStatus = (status: EmbeddingHostStatus) => {
      applyHostStatus(status, {
        setStartWorkerError,
        setStartingWorker,
        setWorkerLocalRunning,
      });
    };

    void host
      .getStatus()
      .then(syncStatus)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setStartWorkerError(message);
      });

    return host.onStatus(syncStatus);
  }, [useEmbeddingHost]);

  const launchWorker = useCallback(
    async (successToast: { title: string; description: string }) => {
      if (useEmbeddingHost) {
        const status = await getEmbeddingHostApi().ensureStarted();
        applyHostStatus(status, {
          setStartWorkerError,
          setStartingWorker,
          setWorkerLocalRunning,
        });
        if (status.state === 'error') {
          throw new Error(status.lastError ?? 'Embedding host failed to start.');
        }
        dispatchQueueDrainedEvent();
        toast(successToast);
        return;
      }
      if (!db) {
        throw new Error('Database is required to start the local embedding worker.');
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
      setStartWorkerError(null);
      dispatchQueueDrainedEvent();
      // Auto-backfill on worker start is disabled - backfill must be triggered manually
      // via the Backfill button in Vector Status. This gives users explicit control
      // over when embedding jobs are enqueued.
      toast(successToast);
    },
    [db, devicePreference, reinitEveryN, toast, useEmbeddingHost]
  );

  const startWorker = useCallback(async () => {
    if (!(db || useEmbeddingHost) || startingWorker) {
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
  }, [db, startingWorker, launchWorker, toast, useEmbeddingHost]);

  const stopWorker = useCallback(async () => {
    if (useEmbeddingHost) {
      const status = await getEmbeddingHostApi().stop();
      applyHostStatus(status, {
        setStartWorkerError,
        setStartingWorker,
        setWorkerLocalRunning,
      });
      toast({ title: 'Worker stopped' });
      return;
    }
    try {
      await workerControllerRef.current?.stop();
    } finally {
      workerControllerRef.current = null;
      setWorkerLocalRunning(false);
      toast({ title: 'Worker stopped' });
    }
  }, [toast, useEmbeddingHost]);

  const resetWorker = useCallback(async () => {
    if (!(db || useEmbeddingHost)) {
      return;
    }
    setStartWorkerError(null);
    setStartingWorker(true);
    try {
      if (useEmbeddingHost) {
        const status = await getEmbeddingHostApi().reset();
        applyHostStatus(status, {
          setStartWorkerError,
          setStartingWorker,
          setWorkerLocalRunning,
        });
        if (status.state === 'error') {
          throw new Error(status.lastError ?? 'Embedding host failed to reset.');
        }
        toast({
          title: 'Worker reset',
          description: 'Embedding worker restarted successfully.',
        });
        return;
      }
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
  }, [db, workerLocalRunning, launchWorker, toast, useEmbeddingHost]);

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
