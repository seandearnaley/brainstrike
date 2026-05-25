import { createLogger } from '@brainstrike/utils';
import type { Pool, WorkerPoolOptions, Promise as WorkerPoolPromise } from 'workerpool';
import workerpool from 'workerpool';
import type { WorkerpoolAdapterOptions } from '../browser-workerpool-options';
import { emitQueueTelemetry, type QueueTelemetryEvent } from '../telemetry';
import {
  type QueueAdapter,
  type QueueAddBulkOptions,
  type QueueAddOptions,
  type QueueErrorEvent,
  type QueueProgressEvent,
  type QueueResult,
  type TaskPayload,
  toWorkerRequest,
} from '../types';
import { estimateHardwareConcurrency, ProgressEmitter } from '../util';

const logger = createLogger('BrowserWorkerpoolAdapter');

type WorkerEvent = QueueProgressEvent | QueueErrorEvent;

function isWorkerEvent(value: unknown): value is WorkerEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const typeValue = record['type'];
  return typeValue === 'progress' || typeValue === 'error';
}

const DEFAULT_MAX_WORKERS_CAP = 8;
// Conservative ceiling for CPU/WASM defaults — multiple workers each load
// their own model copy, so on typical laptops more than 4 pushes memory hard.
const DEFAULT_CPU_WORKERS_CAP = 4;

/**
 * Lightweight WebGPU presence probe. Avoids actually requesting an adapter
 * (which would warm a GPU device just to count workers) — we only need the
 * sniff to choose a default.
 */
function hasWebGPUSupport(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Device-aware default worker count.
 *
 * - WebGPU available → 1 worker. Each WebGPU worker loads a full model and
 *   pins a GPU device, so multiple workers multiply memory pressure and can
 *   destabilize the shared device.
 * - WebGPU absent → up to {@link DEFAULT_CPU_WORKERS_CAP} workers, sized by
 *   `hardwareConcurrency - 1` (leaving a core for the main thread).
 *
 * Callers can still override with `options.maxWorkers`.
 */
function deviceAwareDefaultMaxWorkers(hardwareConcurrency: number): number {
  if (hasWebGPUSupport()) {
    return 1;
  }
  return Math.max(1, Math.min(hardwareConcurrency - 1, DEFAULT_CPU_WORKERS_CAP));
}

function attachAbort(
  signal: AbortSignal | undefined,
  promise: WorkerPoolPromise<QueueResult>,
  description: string
): void {
  if (signal === undefined) {
    return;
  }
  if (signal.aborted) {
    logger.debug('Cancelling worker task (%s) due to pre-aborted signal', description);
    promise.cancel();
    return;
  }
  const abortListener = () => {
    logger.debug('Cancelling worker task (%s) due to abort signal', description);
    promise.cancel();
  };
  signal.addEventListener('abort', abortListener, { once: true });
  promise
    .finally(() => {
      signal.removeEventListener('abort', abortListener);
    })
    .catch(() => {
      signal.removeEventListener('abort', abortListener);
    });
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function calculateElapsed(startedAt: number): number {
  return Math.round(now() - startedAt);
}

export function createWorkerpoolAdapter(options: WorkerpoolAdapterOptions = {}): QueueAdapter {
  if (!(typeof options.workerUrl === 'string' && options.workerUrl.length > 0)) {
    throw new Error('createWorkerpoolAdapter requires an explicit workerUrl.');
  }
  const hardwareConcurrency = estimateHardwareConcurrency();
  // MDN documents `navigator.hardwareConcurrency` as the number of logical
  // cores. We default conservatively based on whether the device exposes
  // WebGPU (single worker, since each one pins a GPU device + model copy)
  // or only CPU/WASM (a small handful of workers capped on memory).
  // Source: https://developer.mozilla.org/docs/Web/API/NavigatorConcurrentHardware/hardwareConcurrency
  const defaultMaxWorkers = deviceAwareDefaultMaxWorkers(hardwareConcurrency);
  const maxWorkers = Math.max(
    1,
    Math.min(options.maxWorkers ?? defaultMaxWorkers, DEFAULT_MAX_WORKERS_CAP)
  );
  const workerScript = options.workerUrl;
  const minWorkers = options.minWorkers ?? 1;
  const poolOptions: WorkerPoolOptions = {
    minWorkers,
    maxWorkers: Math.max(minWorkers, maxWorkers),
    maxQueueSize: options.maxQueueSize ?? Number.POSITIVE_INFINITY,
    workerType: 'web',
    workerOpts: { type: 'module' },
  };
  const pool: Pool = workerpool.pool(workerScript, poolOptions);

  let paused = false;
  let canceled = false;
  const resumeWaiters: Array<() => void> = [];
  const cancelWaiters: Array<() => void> = [];
  const emitter = new ProgressEmitter<WorkerEvent>();
  let activeTasks = 0;
  const drainWaiters: Array<() => void> = [];

  const notifyDrain = () => {
    if (activeTasks === 0) {
      while (drainWaiters.length > 0) {
        const resolve = drainWaiters.pop();
        resolve?.();
      }
    }
  };

  const notifyCancel = () => {
    if (activeTasks === 0) {
      while (cancelWaiters.length > 0) {
        const resolve = cancelWaiters.pop();
        resolve?.();
      }
    }
  };

  const waitForResume = (): Promise<void> => {
    if (!paused) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      resumeWaiters.push(resolve);
    });
  };

  const execute = async (
    task: TaskPayload,
    opts?: QueueAddOptions | QueueAddBulkOptions
  ): Promise<QueueResult> => {
    await waitForResume();
    const { promise, cancelable, startedAt } = createExecutionPromise(task);
    attachAbort((opts as QueueAddOptions | undefined)?.signal, cancelable, task.id);
    activeTasks += 1;
    try {
      const result = await promise;
      onTaskComplete(task, startedAt);
      return result;
    } catch (error) {
      onTaskError(task, startedAt, error);
      throw error;
    } finally {
      activeTasks = Math.max(activeTasks - 1, 0);
      notifyDrain();
      notifyCancel();
    }
  };

  const createExecutionPromise = (task: TaskPayload) => {
    const startedAt = now();
    const request = toWorkerRequest(task);
    const execPromise = pool.exec('runEmbedding', [request], {
      on: (event: unknown) => {
        if (isWorkerEvent(event)) {
          emitter.emit(event);
        }
      },
    }) as WorkerPoolPromise<QueueResult>;

    const pendingTasks = readPendingTasks();
    const statsMetadata = readStatsMetadata();
    const telemetry: QueueTelemetryEvent = {
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: task.id,
      model: task.model,
      activeBefore: activeTasks,
      ...(pendingTasks === undefined ? {} : { pending: pendingTasks }),
      ...(statsMetadata === undefined ? {} : { metadata: statsMetadata }),
    };
    emitQueueTelemetry(telemetry);

    return { promise: execPromise, cancelable: execPromise, startedAt };
  };

  const onTaskComplete = (task: TaskPayload, startedAt: number) => {
    const pendingTasks = readPendingTasks();
    const statsMetadata = readStatsMetadata();
    const telemetry: QueueTelemetryEvent = {
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'complete',
      taskId: task.id,
      model: task.model,
      elapsedMs: calculateElapsed(startedAt),
      activeBefore: activeTasks,
      activeAfter: Math.max(activeTasks - 1, 0),
      ...(pendingTasks === undefined ? {} : { pending: pendingTasks }),
      ...(statsMetadata === undefined ? {} : { metadata: statsMetadata }),
    };
    emitQueueTelemetry(telemetry);
    // Use debug level for per-task completion to reduce log noise during bulk operations
    logger.debug('Workerpool embedding task complete', {
      taskId: task.id,
      elapsedMs: calculateElapsed(startedAt),
      activeBeforeRelease: activeTasks,
      activeAfterRelease: Math.max(activeTasks - 1, 0),
      pending: pendingTasks,
    });
  };

  const onTaskError = (task: TaskPayload, startedAt: number, error: unknown) => {
    // Extract as much error information as possible
    let errorMessage: string;
    let errorStack: string | undefined;
    let errorDetails: Record<string, unknown> | undefined;

    if (error instanceof Error) {
      errorMessage = error.message;
      errorStack = error.stack;
      // Check for nested cause (workerpool may wrap errors)
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause) {
        errorDetails = { cause: cause instanceof Error ? cause.message : String(cause) };
      }
    } else if (typeof error === 'object' && error !== null) {
      // Workerpool may return error objects that aren't Error instances
      const errorObj = error as Record<string, unknown>;
      errorMessage = String(errorObj['message'] ?? errorObj['error'] ?? JSON.stringify(error));
      errorStack = String(errorObj['stack'] ?? '');
      errorDetails = { ...errorObj };
    } else {
      errorMessage = String(error);
    }

    const telemetry: QueueTelemetryEvent = {
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'error',
      taskId: task.id,
      model: task.model,
      elapsedMs: calculateElapsed(startedAt),
      activeBefore: activeTasks,
      activeAfter: Math.max(activeTasks - 1, 0),
      errorMessage,
    };
    emitQueueTelemetry(telemetry);
    logger.debug('Workerpool embedding task failed', {
      taskId: task.id,
      model: task.model,
      elapsedMs: calculateElapsed(startedAt),
      activeBeforeRelease: activeTasks,
      activeAfterRelease: Math.max(activeTasks - 1, 0),
      error: errorMessage,
      stack: errorStack,
      details: errorDetails,
      rawError: typeof error === 'object' ? JSON.stringify(error) : String(error),
    });
  };

  const readPendingTasks = () => {
    const stats = typeof pool.stats === 'function' ? pool.stats() : null;
    return stats?.pendingTasks;
  };

  const readStatsMetadata = () => {
    const stats = typeof pool.stats === 'function' ? pool.stats() : null;
    return stats ? { pendingTasks: stats.pendingTasks } : undefined;
  };

  return {
    async add(task, opts) {
      if (canceled) {
        throw new Error('Adapter has been canceled');
      }
      return execute(task, opts);
    },
    async addBulk(tasks, opts) {
      if (canceled) {
        throw new Error('Adapter has been canceled');
      }
      const promises = tasks.map((task) => execute(task, opts));
      return Promise.all(promises);
    },
    onProgress(listener) {
      return emitter.add(listener);
    },
    pause() {
      paused = true;
      logger.debug('Workerpool adapter paused');
    },
    resume() {
      if (!paused) {
        return;
      }
      paused = false;
      logger.debug('Workerpool adapter resumed');
      while (resumeWaiters.length > 0) {
        const resolve = resumeWaiters.shift();
        resolve?.();
      }
    },
    async cancel() {
      if (canceled) {
        return;
      }
      canceled = true;
      paused = true; // Prevent new tasks
      logger.debug('Workerpool adapter canceling', { activeTasks });

      // Terminate the pool (cancels pending and running tasks)
      await pool.terminate(true);

      // Wait for active tasks to complete their cleanup
      if (activeTasks > 0) {
        await new Promise<void>((resolve) => {
          cancelWaiters.push(resolve);
        });
      }

      logger.debug('Workerpool adapter canceled');
    },
    async dispose() {
      // dispose() and cancel() share termination semantics — the canceled
      // flag (and its associated terminate-once guard) keeps dispose
      // idempotent without a separate code path.
      if (canceled) {
        return;
      }
      canceled = true;
      paused = true;
      logger.debug('Workerpool adapter disposing', { activeTasks });
      await pool.terminate(true);
      if (activeTasks > 0) {
        await new Promise<void>((resolve) => {
          cancelWaiters.push(resolve);
        });
      }
      logger.debug('Workerpool adapter disposed');
    },
    async drain() {
      if (activeTasks === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },
    get isPaused() {
      return paused;
    },
    get isProcessing() {
      return activeTasks > 0;
    },
  };
}
