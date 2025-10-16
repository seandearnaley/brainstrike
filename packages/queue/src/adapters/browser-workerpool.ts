import { resolveEmbeddingWorkerUrl } from '@brainstrike/embedding-worker';
import { createLogger } from '@brainstrike/utils';
import type { Pool, WorkerPoolOptions, Promise as WorkerPoolPromise } from 'workerpool';
import workerpool from 'workerpool';
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

export type WorkerpoolAdapterOptions = {
  readonly maxWorkers?: number;
  readonly maxQueueSize?: number;
  readonly name?: string;
};

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
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function calculateElapsed(startedAt: number): number {
  return Math.round(now() - startedAt);
}

export function createWorkerpoolAdapter(options: WorkerpoolAdapterOptions = {}): QueueAdapter {
  const hardwareConcurrency = estimateHardwareConcurrency();
  // MDN documents `navigator.hardwareConcurrency` as the number of logical cores. This allows us to size the pool conservatively.
  // Source: https://developer.mozilla.org/docs/Web/API/NavigatorConcurrentHardware/hardwareConcurrency
  const maxWorkers = Math.max(
    1,
    Math.min(options.maxWorkers ?? Math.max(1, hardwareConcurrency - 1), DEFAULT_MAX_WORKERS_CAP)
  );
  const workerScript = resolveEmbeddingWorkerUrl().href;
  const poolOptions: WorkerPoolOptions = {
    maxWorkers,
    maxQueueSize: options.maxQueueSize ?? Number.POSITIVE_INFINITY,
    workerType: 'web',
    workerOpts: { type: 'module' },
  };
  const pool: Pool = workerpool.pool(workerScript, poolOptions);

  let paused = false;
  const resumeWaiters: Array<() => void> = [];
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
      ...(pendingTasks !== undefined ? { pending: pendingTasks } : {}),
      ...(statsMetadata !== undefined ? { metadata: statsMetadata } : {}),
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
      ...(pendingTasks !== undefined ? { pending: pendingTasks } : {}),
      ...(statsMetadata !== undefined ? { metadata: statsMetadata } : {}),
    };
    emitQueueTelemetry(telemetry);
    logger.info('Workerpool embedding task complete', {
      taskId: task.id,
      elapsedMs: calculateElapsed(startedAt),
      activeBeforeRelease: activeTasks,
      activeAfterRelease: Math.max(activeTasks - 1, 0),
      pending: pendingTasks,
    });
  };

  const onTaskError = (task: TaskPayload, startedAt: number, error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
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
    logger.error('Workerpool embedding task failed', {
      taskId: task.id,
      elapsedMs: calculateElapsed(startedAt),
      activeBeforeRelease: activeTasks,
      activeAfterRelease: Math.max(activeTasks - 1, 0),
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
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
      return execute(task, opts);
    },
    async addBulk(tasks, opts) {
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
    async drain() {
      if (activeTasks === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },
  };
}
