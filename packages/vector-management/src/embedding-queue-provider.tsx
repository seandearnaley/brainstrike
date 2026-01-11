import { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } from '@brainstrike/embeddings';
import { useVectorStatusUIStore } from '@brainstrike/preferences';
import {
  addQueueTelemetryListener,
  createBrowserEmbeddingQueue,
  createQueueTelemetryAggregator,
  type QueueAdapter,
  type QueueErrorEvent,
  type QueueProgressEvent,
} from '@brainstrike/queue';
import type { PropsWithChildren, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

interface ProgressSnapshot {
  readonly id: string;
  readonly progress: number;
  readonly phase: string;
}

interface QueueMetrics {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly totalEnqueued: number;
  readonly lastError: string | null;
  readonly progress: Record<string, ProgressSnapshot>;
  readonly throughputPerMinute: number;
  readonly latencyAvgMs: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly windowErrorCount: number;
}

const INITIAL_METRICS: QueueMetrics = {
  active: 0,
  completed: 0,
  failed: 0,
  totalEnqueued: 0,
  lastError: null,
  progress: {},
  throughputPerMinute: 0,
  latencyAvgMs: null,
  latencyP50Ms: null,
  latencyP95Ms: null,
  windowErrorCount: 0,
};

interface EmbeddingQueueContextValue {
  queue: QueueAdapter;
  metrics: QueueMetrics;
}

const EmbeddingQueueContext = createContext<EmbeddingQueueContextValue | null>(null);

export interface EmbeddingQueueProviderProps {
  readonly adapter?: QueueAdapter;
}

export function EmbeddingQueueProvider({
  children,
  adapter,
}: PropsWithChildren<EmbeddingQueueProviderProps>): ReactNode {
  const baseAdapterRef = useRef<QueueAdapter | null>(null);
  if (baseAdapterRef.current === null) {
    baseAdapterRef.current = adapter ?? createBrowserEmbeddingQueue({ requireWorkerpool: true });
  }

  const [metrics, setMetrics] = useState<QueueMetrics>(INITIAL_METRICS);
  const setIsEmbeddingQueueActive = useVectorStatusUIStore((s) => s.setIsEmbeddingQueueActive);
  const canUseTelemetry = typeof window !== 'undefined' && typeof window.Worker !== 'undefined';
  const telemetryAggregatorRef = useRef(canUseTelemetry ? createQueueTelemetryAggregator() : null);

  const updateMetrics = useCallback((updater: (prev: QueueMetrics) => QueueMetrics) => {
    setMetrics((prev) => {
      const next = updater(prev);
      return next === prev ? prev : next;
    });
  }, []);

  const recordProgress = useCallback(
    (event: QueueProgressEvent) => {
      updateMetrics((prev) => {
        const existing = prev.progress[event.id];
        if (existing && existing.progress === event.progress && existing.phase === event.phase) {
          return prev;
        }
        return {
          ...prev,
          progress: {
            ...prev.progress,
            [event.id]: {
              id: event.id,
              progress: event.progress,
              phase: event.phase,
            },
          },
        };
      });
    },
    [updateMetrics]
  );

  const recordFailure = useCallback(
    (jobId: string, message: string | null) => {
      updateMetrics((prev) => ({
        ...prev,
        active: Math.max(0, prev.active - 1),
        failed: prev.failed + 1,
        lastError: message ?? prev.lastError,
        progress: (() => {
          if (!(jobId in prev.progress)) {
            return prev.progress;
          }
          const { [jobId]: _removed, ...rest } = prev.progress;
          return rest;
        })(),
      }));
    },
    [updateMetrics]
  );

  const recordEnqueue = useCallback(() => {
    updateMetrics((prev) => ({
      ...prev,
      active: prev.active + 1,
      totalEnqueued: prev.totalEnqueued + 1,
    }));
  }, [updateMetrics]);

  const recordSuccess = useCallback(() => {
    updateMetrics((prev) => ({
      ...prev,
      active: Math.max(0, prev.active - 1),
      completed: prev.completed + 1,
    }));
  }, [updateMetrics]);

  const instrumentedQueue = useMemo(() => {
    const base = baseAdapterRef.current;
    if (!base) {
      throw new Error('Embedding queue adapter not initialised');
    }
    const listeners = new Set<(event: QueueProgressEvent | QueueErrorEvent) => void>();

    const unsubscribe = base.onProgress((event) => {
      if (event.type === 'progress') {
        recordProgress(event);
      } else if (event.type === 'error') {
        recordFailure(event.id, event.message);
      }
      listeners.forEach((listener) => {
        listener(event);
      });
    });

    const wrapped: QueueAdapter = {
      add: async (task, opts) => {
        recordEnqueue();
        try {
          const result = await base.add(task, opts);
          recordSuccess();
          updateMetrics((prev) => {
            if (!(task.id in prev.progress)) {
              return prev;
            }
            const { [task.id]: _removed, ...rest } = prev.progress;
            return { ...prev, progress: rest };
          });
          return result;
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Unknown error';
          recordFailure(task.id, message);
          throw error;
        }
      },
      addBulk: async (tasks, opts) => Promise.all(tasks.map((task) => wrapped.add(task, opts))),
      onProgress(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      pause() {
        base.pause();
      },
      resume() {
        base.resume();
      },
      async cancel() {
        await base.cancel();
      },
      async drain() {
        await base.drain();
      },
      get isPaused() {
        return base.isPaused;
      },
      get isProcessing() {
        return base.isProcessing;
      },
    };

    return {
      queue: wrapped,
      unsubscribe,
    };
  }, [recordEnqueue, recordFailure, recordProgress, recordSuccess, updateMetrics]);

  useEffect(
    () => () => {
      telemetryAggregatorRef.current?.dispose();
    },
    []
  );

  useEffect(() => {
    if (!(canUseTelemetry && telemetryAggregatorRef.current)) {
      return () => {};
    }
    const unsubscribeTelemetry = addQueueTelemetryListener(() => {
      const snapshot = telemetryAggregatorRef.current?.snapshot();
      if (!snapshot) {
        return;
      }
      updateMetrics((prev) => ({
        ...prev,
        throughputPerMinute: snapshot.throughputPerMinute,
        latencyAvgMs: snapshot.averageLatencyMs,
        latencyP50Ms: snapshot.latencyP50Ms,
        latencyP95Ms: snapshot.latencyP95Ms,
        windowErrorCount: snapshot.errorCount,
      }));
    });
    return () => unsubscribeTelemetry();
  }, [canUseTelemetry, updateMetrics]);

  useEffect(() => {
    registerEmbeddingQueueFactory(() => instrumentedQueue.queue);
    return () => {
      instrumentedQueue.unsubscribe();
      resetEmbeddingQueueFactory();
    };
  }, [instrumentedQueue]);

  const lastQueueActiveRef = useRef(false);
  const queueActiveClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isActive = metrics.active > 0;
    if (isActive) {
      if (queueActiveClearTimeoutRef.current) {
        clearTimeout(queueActiveClearTimeoutRef.current);
        queueActiveClearTimeoutRef.current = null;
      }
      if (!lastQueueActiveRef.current) {
        lastQueueActiveRef.current = true;
        setIsEmbeddingQueueActive(true);
      }
      return;
    }

    if (!lastQueueActiveRef.current) {
      return;
    }

    if (queueActiveClearTimeoutRef.current) {
      clearTimeout(queueActiveClearTimeoutRef.current);
    }

    queueActiveClearTimeoutRef.current = setTimeout(() => {
      lastQueueActiveRef.current = false;
      setIsEmbeddingQueueActive(false);
      queueActiveClearTimeoutRef.current = null;
    }, 1500);
  }, [metrics.active, setIsEmbeddingQueueActive]);

  // biome-ignore lint/plugin: Cleanup resets shared queue activity state on unmount.
  useEffect(
    () => () => {
      if (queueActiveClearTimeoutRef.current) {
        clearTimeout(queueActiveClearTimeoutRef.current);
        queueActiveClearTimeoutRef.current = null;
      }
      lastQueueActiveRef.current = false;
      setIsEmbeddingQueueActive(false);
    },
    [setIsEmbeddingQueueActive]
  );

  const contextValue = useMemo<EmbeddingQueueContextValue>(
    () => ({ queue: instrumentedQueue.queue, metrics }),
    [instrumentedQueue.queue, metrics]
  );

  return (
    <EmbeddingQueueContext.Provider value={contextValue}>{children}</EmbeddingQueueContext.Provider>
  );
}

export function useEmbeddingQueue(): EmbeddingQueueContextValue {
  const context = useContext(EmbeddingQueueContext);
  if (!context) {
    throw new Error('useEmbeddingQueue must be used within an EmbeddingQueueProvider');
  }
  return context;
}

/**
 * Safe variant of useEmbeddingQueue that returns null instead of throwing
 * when called outside of EmbeddingQueueProvider. Useful for components that
 * can optionally use the embedding queue when available.
 */
export function useEmbeddingQueueSafe(): EmbeddingQueueContextValue | null {
  return useContext(EmbeddingQueueContext);
}
