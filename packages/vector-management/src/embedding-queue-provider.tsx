import {
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import {
  addQueueTelemetryListener,
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
  readonly phase: string;
  readonly progress: number;
}

interface QueueMetrics {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly lastError: string | null;
  readonly latencyAvgMs: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly progress: Record<string, ProgressSnapshot>;
  readonly throughputPerMinute: number;
  readonly totalEnqueued: number;
  readonly windowErrorCount: number;
}

function removeProgressEntry(
  progress: Record<string, ProgressSnapshot>,
  id: string
): Record<string, ProgressSnapshot> {
  if (!(id in progress)) {
    return progress;
  }
  const next: Record<string, ProgressSnapshot> = {};
  for (const key of Object.keys(progress)) {
    if (key !== id) {
      next[key] = progress[key] as ProgressSnapshot;
    }
  }
  return next;
}

function rethrow(error: unknown): never {
  throw error;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

type RecordFailureFn = (jobId: string, message: string | null) => void;
type RecordEnqueueFn = () => void;
type RecordSuccessFn = () => void;
type UpdateMetricsFn = (updater: (prev: QueueMetrics) => QueueMetrics) => void;
type ListenersSet = Set<(event: QueueProgressEvent | QueueErrorEvent) => void>;

class InstrumentedQueueAdapter implements QueueAdapter {
  readonly #base: QueueAdapter;
  readonly #listeners: ListenersSet;
  readonly #recordEnqueue: RecordEnqueueFn;
  readonly #recordSuccess: RecordSuccessFn;
  readonly #recordFailure: RecordFailureFn;
  readonly #updateMetrics: UpdateMetricsFn;

  constructor(
    base: QueueAdapter,
    listeners: ListenersSet,
    recordEnqueue: RecordEnqueueFn,
    recordSuccess: RecordSuccessFn,
    recordFailure: RecordFailureFn,
    updateMetrics: UpdateMetricsFn
  ) {
    this.#base = base;
    this.#listeners = listeners;
    this.#recordEnqueue = recordEnqueue;
    this.#recordSuccess = recordSuccess;
    this.#recordFailure = recordFailure;
    this.#updateMetrics = updateMetrics;
  }

  get isPaused(): boolean {
    return this.#base.isPaused;
  }

  get isProcessing(): boolean {
    return this.#base.isProcessing;
  }

  async add(
    task: Parameters<QueueAdapter['add']>[0],
    opts?: Parameters<QueueAdapter['add']>[1]
  ): Promise<Awaited<ReturnType<QueueAdapter['add']>>> {
    this.#recordEnqueue();
    try {
      const result = await this.#base.add(task, opts);
      this.#recordSuccess();
      this.#updateMetrics((prev) => ({
        ...prev,
        progress: removeProgressEntry(prev.progress, task.id),
      }));
      return result;
    } catch (error) {
      const message = extractErrorMessage(error);
      this.#recordFailure(task.id, message);
      rethrow(error);
    }
  }

  async addBulk(
    tasks: Parameters<QueueAdapter['addBulk']>[0],
    opts?: Parameters<QueueAdapter['addBulk']>[1]
  ): Promise<Awaited<ReturnType<QueueAdapter['addBulk']>>> {
    return Promise.all(tasks.map((task) => this.add(task, opts)));
  }

  onProgress(
    listener: Parameters<QueueAdapter['onProgress']>[0]
  ): ReturnType<QueueAdapter['onProgress']> {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pause(): void {
    this.#base.pause();
  }

  resume(): void {
    this.#base.resume();
  }

  async cancel(): Promise<void> {
    await this.#base.cancel();
  }

  async drain(): Promise<void> {
    await this.#base.drain();
  }
}

const INITIAL_METRICS: QueueMetrics = {
  active: 0,
  completed: 0,
  failed: 0,
  lastError: null,
  latencyAvgMs: null,
  latencyP50Ms: null,
  latencyP95Ms: null,
  progress: {},
  throughputPerMinute: 0,
  totalEnqueued: 0,
  windowErrorCount: 0,
};

interface EmbeddingQueueContextValue {
  metrics: QueueMetrics;
  queue: QueueAdapter;
}

const EmbeddingQueueContext = createContext<EmbeddingQueueContextValue | null>(null);

let browserEmbeddingQueuePromise: Promise<QueueAdapter> | null = null;
type BrowserEmbeddingQueueLoader = () => Promise<QueueAdapter>;

async function defaultBrowserEmbeddingQueueLoader(): Promise<QueueAdapter> {
  const { createBrowserEmbeddingQueue } = await import('@brainstrike/queue/browser');
  return createBrowserEmbeddingQueue({ requireWorkerpool: true });
}

let browserEmbeddingQueueLoader: BrowserEmbeddingQueueLoader = defaultBrowserEmbeddingQueueLoader;

async function loadBrowserEmbeddingQueue(): Promise<QueueAdapter> {
  if (!browserEmbeddingQueuePromise) {
    browserEmbeddingQueuePromise = browserEmbeddingQueueLoader().catch((error: unknown) => {
      browserEmbeddingQueuePromise = null;
      throw error;
    });
  }
  return browserEmbeddingQueuePromise;
}

export function setBrowserEmbeddingQueueLoaderForTests(
  loader: null | BrowserEmbeddingQueueLoader
): void {
  browserEmbeddingQueueLoader = loader ?? defaultBrowserEmbeddingQueueLoader;
  browserEmbeddingQueuePromise = null;
}

export interface EmbeddingQueueProviderProps {
  readonly adapter?: QueueAdapter;
}

export function EmbeddingQueueProvider({
  children,
  adapter,
}: PropsWithChildren<EmbeddingQueueProviderProps>): ReactNode {
  const [baseAdapter, setBaseAdapter] = useState<QueueAdapter | null>(adapter ?? null);
  const [adapterLoadError, setAdapterLoadError] = useState<Error | null>(null);

  const [metrics, setMetrics] = useState<QueueMetrics>(INITIAL_METRICS);
  const setIsEmbeddingQueueActive = useVectorStatusUIStore((s) => s.setIsEmbeddingQueueActive);
  const canUseTelemetry = typeof window !== 'undefined' && typeof window.Worker !== 'undefined';
  const telemetryAggregatorRef = useRef(canUseTelemetry ? createQueueTelemetryAggregator() : null);

  useEffect(() => {
    if (adapter) {
      setBaseAdapter(adapter);
      setAdapterLoadError(null);
      return;
    }

    let cancelled = false;
    loadBrowserEmbeddingQueue()
      .then((queue) => {
        if (!cancelled) {
          setBaseAdapter(queue);
          setAdapterLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAdapterLoadError(
            error instanceof Error ? error : new Error('Failed to load browser embedding queue.')
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [adapter]);

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
              phase: event.phase,
              progress: event.progress,
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
        progress: removeProgressEntry(prev.progress, jobId),
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
    if (!baseAdapter) {
      return null;
    }
    const listeners = new Set<(event: QueueProgressEvent | QueueErrorEvent) => void>();

    const unsubscribe = baseAdapter.onProgress((event) => {
      if (event.type === 'progress') {
        recordProgress(event);
      } else if (event.type === 'error') {
        recordFailure(event.id, event.message);
      }
      listeners.forEach((listener) => {
        listener(event);
      });
    });

    const queue = new InstrumentedQueueAdapter(
      baseAdapter,
      listeners,
      recordEnqueue,
      recordSuccess,
      recordFailure,
      updateMetrics
    );

    return {
      queue,
      unsubscribe,
    };
  }, [baseAdapter, recordEnqueue, recordFailure, recordProgress, recordSuccess, updateMetrics]);

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
        latencyAvgMs: snapshot.averageLatencyMs,
        latencyP50Ms: snapshot.latencyP50Ms,
        latencyP95Ms: snapshot.latencyP95Ms,
        throughputPerMinute: snapshot.throughputPerMinute,
        windowErrorCount: snapshot.errorCount,
      }));
    });
    return () => unsubscribeTelemetry();
  }, [canUseTelemetry, updateMetrics]);

  useEffect(() => {
    if (!instrumentedQueue) {
      resetEmbeddingQueueFactory();
      return () => {};
    }
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

  const contextValue = useMemo<EmbeddingQueueContextValue | null>(
    () => (instrumentedQueue ? { metrics, queue: instrumentedQueue.queue } : null),
    [instrumentedQueue, metrics]
  );

  if (adapterLoadError) {
    throw adapterLoadError;
  }

  if (!contextValue) {
    return children;
  }

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
