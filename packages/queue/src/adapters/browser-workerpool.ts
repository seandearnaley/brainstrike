import {
  assertEmbedWorkerPipelineCacheDiagnostic,
  assertEmbedWorkerTelemetrySourceClosed,
  EMBED_WORKER_INSTANCE_NAME_PREFIX,
  EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY,
  type EmbedWorkerPipelineCacheDiagnostic,
} from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import type { Pool, WorkerPoolOptions, Promise as WorkerPoolPromise } from 'workerpool';
import workerpool from 'workerpool';
import {
  assertWorkerpoolEmbeddingTelemetrySink,
  type WorkerpoolAdapterOptions,
} from '../browser-workerpool-options.js';
import { emitQueueTelemetry, type QueueTelemetryEvent } from '../telemetry.js';
import {
  type QueueAdapter,
  type QueueAddBulkOptions,
  type QueueAddOptions,
  type QueueErrorEvent,
  type QueueProgressEvent,
  type QueueResult,
  type TaskPayload,
  toWorkerRequest,
} from '../types.js';
import { estimateHardwareConcurrency, ProgressEmitter } from '../util.js';

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

function readPipelineCacheDiagnostic(value: unknown): EmbedWorkerPipelineCacheDiagnostic | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!(record['diagnostic'] === 'pipeline-cache' && record['type'] === 'diagnostic')) {
    return null;
  }
  assertEmbedWorkerPipelineCacheDiagnostic(value);
  return value;
}

const MANAGED_WORKER_SCRIPT_FRAGMENT_KEY = 'brainstrike-embedding-worker-instance';
const WORKER_LIFETIME_TELEMETRY_CHANNEL_PREFIX = 'brainstrike-embedding-worker-telemetry:';
const MISSING_PIPELINE_CACHE_DIAGNOSTIC_REASON =
  'Workerpool result arrived without a pipeline-cache source diagnostic.';

function tagManagedWorkerScript(
  workerScript: string | undefined,
  workerInstanceId: string,
  telemetryChannelName: string
): string {
  if (!(typeof workerScript === 'string' && workerScript.length > 0)) {
    throw new Error('Embedding workerpool worker is missing its explicit script URL.');
  }

  const fragmentStart = workerScript.indexOf('#');
  const existingFragment = fragmentStart === -1 ? '' : workerScript.slice(fragmentStart + 1);
  const fragmentParams = new URLSearchParams(existingFragment);
  if (fragmentParams.has(MANAGED_WORKER_SCRIPT_FRAGMENT_KEY)) {
    throw new Error('Embedding worker script URL already contains a managed instance identity.');
  }
  if (fragmentParams.has(EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY)) {
    throw new Error('Embedding worker script URL already contains a managed telemetry channel.');
  }

  fragmentParams.append(MANAGED_WORKER_SCRIPT_FRAGMENT_KEY, workerInstanceId);
  fragmentParams.append(EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY, telemetryChannelName);
  const scriptWithoutFragment =
    fragmentStart === -1 ? workerScript : workerScript.slice(0, fragmentStart);
  return `${scriptWithoutFragment}#${fragmentParams.toString()}`;
}

function readManagedWorkerInstanceId(workerScript: string | undefined): string {
  if (!(typeof workerScript === 'string' && workerScript.length > 0)) {
    throw new Error('Terminated embedding worker is missing its managed script URL.');
  }

  const fragmentStart = workerScript.indexOf('#');
  if (fragmentStart === -1) {
    throw new Error('Terminated embedding worker script is missing its instance identity.');
  }

  const fragmentParams = new URLSearchParams(workerScript.slice(fragmentStart + 1));
  const workerInstanceIds = fragmentParams.getAll(MANAGED_WORKER_SCRIPT_FRAGMENT_KEY);
  const workerInstanceId = workerInstanceIds[0];
  if (workerInstanceIds.length !== 1 || !workerInstanceId) {
    throw new Error('Terminated embedding worker script has an invalid instance identity.');
  }
  return workerInstanceId;
}

function calculateTransferBytes(vectors: QueueResult['vectors']): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const vector of vectors) {
    buffers.add(vector.buffer);
  }
  let bytes = 0;
  for (const buffer of buffers) {
    bytes += buffer.byteLength;
  }
  return bytes;
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
function deviceAwareDefaultMaxWorkers(
  hardwareConcurrency: number,
  deviceHint: WorkerpoolAdapterOptions['defaultDeviceHint']
): number {
  const hasWebGpu = hasWebGPUSupport();
  const effectiveDeviceHint = deviceHint ?? (hasWebGpu ? 'webgpu' : 'wasm');
  if (effectiveDeviceHint === 'webgpu' && hasWebGpu) {
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

export function createWorkerpoolAdapter(options: WorkerpoolAdapterOptions): QueueAdapter;
export function createWorkerpoolAdapter(options?: WorkerpoolAdapterOptions): QueueAdapter {
  if (!(typeof options?.workerUrl === 'string' && options.workerUrl.length > 0)) {
    throw new Error('createWorkerpoolAdapter requires an explicit workerUrl.');
  }
  assertWorkerpoolEmbeddingTelemetrySink(options.telemetry);
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error('Embedding workerpool telemetry requires BroadcastChannel support.');
  }
  const embeddingTelemetry = options.telemetry;
  const hardwareConcurrency = estimateHardwareConcurrency();
  // MDN documents `navigator.hardwareConcurrency` as the number of logical
  // cores. We default conservatively based on whether the device exposes
  // WebGPU (single worker, since each one pins a GPU device + model copy)
  // or only CPU/WASM (a small handful of workers capped on memory).
  // Source: https://developer.mozilla.org/docs/Web/API/NavigatorConcurrentHardware/hardwareConcurrency
  const defaultMaxWorkers = deviceAwareDefaultMaxWorkers(
    hardwareConcurrency,
    options.defaultDeviceHint
  );
  const maxWorkers = Math.max(
    1,
    Math.min(options.maxWorkers ?? defaultMaxWorkers, DEFAULT_MAX_WORKERS_CAP)
  );
  const workerScript = options.workerUrl;
  const minWorkers = options.minWorkers ?? 1;
  const embeddingTelemetrySourceIds = new Set<string>();
  const managedWorkerInstanceIds = new Set<string>();
  const telemetryChannelName = `${WORKER_LIFETIME_TELEMETRY_CHANNEL_PREFIX}${globalThis.crypto.randomUUID()}`;
  const telemetryChannel = new BroadcastChannel(telemetryChannelName);
  let telemetryChannelClosed = false;
  const closeTelemetryChannel = (): void => {
    if (telemetryChannelClosed) {
      return;
    }
    telemetryChannelClosed = true;
    telemetryChannel.close();
  };
  const clearEmbeddingTelemetrySources = (): void => {
    for (const sourceId of embeddingTelemetrySourceIds) {
      embeddingTelemetry.removeSource(sourceId);
    }
    embeddingTelemetrySourceIds.clear();
    managedWorkerInstanceIds.clear();
  };
  const assertManagedWorkerInstanceId = (workerInstanceId: string): void => {
    if (!managedWorkerInstanceIds.has(workerInstanceId)) {
      throw new Error('Embedding worker telemetry identity is not assigned to this workerpool.');
    }
  };
  const removeWorkerTelemetrySource = (workerInstanceId: string): void => {
    const sourceId = `workerpool-embedding-${workerInstanceId}`;
    if (!embeddingTelemetrySourceIds.delete(sourceId)) {
      return;
    }
    embeddingTelemetry.removeSource(sourceId);
  };
  const removeTerminatedWorkerTelemetrySource = (workerScriptUrl: string | undefined): void => {
    const workerInstanceId = readManagedWorkerInstanceId(workerScriptUrl);
    if (!managedWorkerInstanceIds.delete(workerInstanceId)) {
      throw new Error('Terminated embedding worker identity is not assigned to this workerpool.');
    }
    removeWorkerTelemetrySource(workerInstanceId);
  };
  const recordPipelineCacheDiagnostic = (
    diagnostic: EmbedWorkerPipelineCacheDiagnostic
  ): string => {
    assertManagedWorkerInstanceId(diagnostic.workerInstanceId);
    const sourceId = `workerpool-embedding-${diagnostic.workerInstanceId}`;
    embeddingTelemetrySourceIds.add(sourceId);
    embeddingTelemetry.recordPipelineCache(sourceId, diagnostic);
    return sourceId;
  };
  const poolOptions: WorkerPoolOptions = {
    maxQueueSize: options.maxQueueSize ?? Number.POSITIVE_INFINITY,
    maxWorkers: Math.max(minWorkers, maxWorkers),
    minWorkers,
    onCreateWorker: ({ script, workerOpts }) => {
      const workerInstanceId = globalThis.crypto.randomUUID();
      const taggedWorkerScript = tagManagedWorkerScript(
        script,
        workerInstanceId,
        telemetryChannelName
      );
      managedWorkerInstanceIds.add(workerInstanceId);
      return {
        script: taggedWorkerScript,
        workerOpts: {
          ...workerOpts,
          name: `${EMBED_WORKER_INSTANCE_NAME_PREFIX}${workerInstanceId}`,
        },
      };
    },
    onTerminateWorker: ({ script }) => {
      // workerpool 10.0.3 omits workerOpts here at runtime. Its per-worker
      // script value is preserved, so the fragment correlates termination
      // with the same UUID exposed to the worker through WorkerOptions.name.
      removeTerminatedWorkerTelemetrySource(script);
    },
    workerOpts: { type: 'module' },
    workerType: 'web',
  };
  let pool: Pool;
  try {
    pool = workerpool.pool(workerScript, poolOptions);
  } catch (error) {
    closeTelemetryChannel();
    throw error;
  }
  let workerLifetimeTelemetryFailure: Error | null = null;
  const failWorkerLifetimeTelemetry = (error: unknown): void => {
    if (workerLifetimeTelemetryFailure !== null) {
      return;
    }
    workerLifetimeTelemetryFailure =
      error instanceof Error
        ? error
        : new Error('Embedding worker-lifetime telemetry validation failed.');
    embeddingTelemetry.recordFailure(workerLifetimeTelemetryFailure.message);
    logger.error('Embedding worker-lifetime telemetry failed.', {
      reason: workerLifetimeTelemetryFailure.message,
    });
    closeTelemetryChannel();
    void (async (): Promise<void> => {
      try {
        await pool.terminate(true);
      } catch (terminationError) {
        logger.error('Embedding workerpool termination after telemetry failure failed.', {
          reason:
            terminationError instanceof Error
              ? terminationError.message
              : 'Unknown workerpool termination error.',
        });
      } finally {
        clearEmbeddingTelemetrySources();
      }
    })();
  };
  telemetryChannel.onmessage = (event: MessageEvent<unknown>): void => {
    try {
      if (
        event.data &&
        typeof event.data === 'object' &&
        !Array.isArray(event.data) &&
        (event.data as Record<string, unknown>)['type'] === 'telemetry-source-closed'
      ) {
        assertEmbedWorkerTelemetrySourceClosed(event.data);
        assertManagedWorkerInstanceId(event.data.workerInstanceId);
        removeWorkerTelemetrySource(event.data.workerInstanceId);
        return;
      }
      const diagnostic = readPipelineCacheDiagnostic(event.data);
      if (diagnostic === null || diagnostic.id !== undefined) {
        throw new Error(
          'Embedding worker-lifetime telemetry requires an id-less pipeline-cache diagnostic.'
        );
      }
      recordPipelineCacheDiagnostic(diagnostic);
    } catch (error) {
      failWorkerLifetimeTelemetry(error);
    }
  };

  let paused = false;
  let terminalState: 'active' | 'canceled' | 'disposed' = 'active';
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
    const { promise, cancelable, startedAt, telemetrySource } = createExecutionPromise(task);
    attachAbort((opts as QueueAddOptions | undefined)?.signal, cancelable, task.id);
    activeTasks += 1;
    try {
      const result = await promise;
      if (result.vectors.length > 0) {
        if (telemetrySource.current === null) {
          embeddingTelemetry.recordFailure(MISSING_PIPELINE_CACHE_DIAGNOSTIC_REASON);
          logger.error(MISSING_PIPELINE_CACHE_DIAGNOSTIC_REASON, { taskId: task.id });
        } else {
          embeddingTelemetry.recordBatch(telemetrySource.current, {
            batchIndex: 0,
            endIndex: task.texts.length,
            id: task.id,
            peakVectorsInFlight: result.vectors.length,
            startIndex: 0,
            transferBytes: calculateTransferBytes(result.vectors),
            type: 'batch',
            vectors: result.vectors,
            vectorsInFlight: result.vectors.length,
          });
        }
      }
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
    const telemetrySource: { current: string | null } = { current: null };
    const telemetryError: { current: Error | null } = { current: null };
    let rejectTelemetryError!: (error: Error) => void;
    const telemetryFailure = new Promise<never>((_resolve, reject) => {
      rejectTelemetryError = reject;
    });
    let cancelable: WorkerPoolPromise<QueueResult> | null = null;
    cancelable = pool.exec('runEmbedding', [request], {
      on: (event: unknown) => {
        if (isWorkerEvent(event)) {
          emitter.emit(event);
          return;
        }
        try {
          const diagnostic = readPipelineCacheDiagnostic(event);
          if (diagnostic) {
            telemetrySource.current = recordPipelineCacheDiagnostic(diagnostic);
          }
        } catch (error) {
          telemetryError.current =
            error instanceof Error
              ? error
              : new Error('Embedding worker telemetry validation failed.');
          rejectTelemetryError(telemetryError.current);
          cancelable?.cancel();
          return;
        }
      },
    }) as WorkerPoolPromise<QueueResult>;
    if (telemetryError.current) {
      cancelable.cancel();
    }
    const checkedExecution = cancelable.then(
      (result) => {
        if (telemetryError.current) {
          throw telemetryError.current;
        }
        return result;
      },
      (error: unknown) => {
        if (telemetryError.current) {
          throw telemetryError.current;
        }
        throw error;
      }
    );
    const promise = Promise.race([telemetryFailure, checkedExecution]);

    const pendingTasks = readPendingTasks();
    const statsMetadata = readStatsMetadata();
    const telemetry: QueueTelemetryEvent = {
      activeBefore: activeTasks,
      adapter: 'workerpool',
      event: 'enqueue',
      model: task.model,
      taskId: task.id,
      timestamp: Date.now(),
      ...(pendingTasks === undefined ? {} : { pending: pendingTasks }),
      ...(statsMetadata === undefined ? {} : { metadata: statsMetadata }),
    };
    emitQueueTelemetry(telemetry);

    return { cancelable, promise, startedAt, telemetrySource };
  };

  const onTaskComplete = (task: TaskPayload, startedAt: number) => {
    const pendingTasks = readPendingTasks();
    const statsMetadata = readStatsMetadata();
    const telemetry: QueueTelemetryEvent = {
      activeAfter: Math.max(activeTasks - 1, 0),
      activeBefore: activeTasks,
      adapter: 'workerpool',
      elapsedMs: calculateElapsed(startedAt),
      event: 'complete',
      model: task.model,
      taskId: task.id,
      timestamp: Date.now(),
      ...(pendingTasks === undefined ? {} : { pending: pendingTasks }),
      ...(statsMetadata === undefined ? {} : { metadata: statsMetadata }),
    };
    emitQueueTelemetry(telemetry);
    // Use debug level for per-task completion to reduce log noise during bulk operations
    logger.debug('Workerpool embedding task complete', {
      activeAfterRelease: Math.max(activeTasks - 1, 0),
      activeBeforeRelease: activeTasks,
      elapsedMs: calculateElapsed(startedAt),
      pending: pendingTasks,
      taskId: task.id,
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
      activeAfter: Math.max(activeTasks - 1, 0),
      activeBefore: activeTasks,
      adapter: 'workerpool',
      elapsedMs: calculateElapsed(startedAt),
      errorMessage,
      event: 'error',
      model: task.model,
      taskId: task.id,
      timestamp: Date.now(),
    };
    emitQueueTelemetry(telemetry);
    logger.debug('Workerpool embedding task failed', {
      activeAfterRelease: Math.max(activeTasks - 1, 0),
      activeBeforeRelease: activeTasks,
      details: errorDetails,
      elapsedMs: calculateElapsed(startedAt),
      error: errorMessage,
      model: task.model,
      rawError: typeof error === 'object' ? JSON.stringify(error) : String(error),
      stack: errorStack,
      taskId: task.id,
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

  const assertAcceptingWork = (): void => {
    if (workerLifetimeTelemetryFailure !== null) {
      throw workerLifetimeTelemetryFailure;
    }
    if (terminalState === 'canceled') {
      throw new Error('Adapter has been canceled');
    }
    if (terminalState === 'disposed') {
      throw new Error('Adapter has been disposed');
    }
  };

  const terminateInternal = async (nextState: 'canceled' | 'disposed'): Promise<void> => {
    if (terminalState !== 'active') {
      return;
    }
    terminalState = nextState;
    paused = true;
    logger.debug(`Workerpool adapter ${nextState === 'canceled' ? 'canceling' : 'disposing'}`, {
      activeTasks,
    });
    try {
      await pool.terminate(true);
      if (activeTasks > 0) {
        await new Promise<void>((resolve) => {
          cancelWaiters.push(resolve);
        });
      }
    } finally {
      closeTelemetryChannel();
      clearEmbeddingTelemetrySources();
    }
    logger.debug(`Workerpool adapter ${nextState}`);
  };

  return {
    async add(task, opts) {
      assertAcceptingWork();
      return execute(task, opts);
    },
    async addBulk(tasks, opts) {
      assertAcceptingWork();
      const promises = tasks.map((task) => execute(task, opts));
      return Promise.all(promises);
    },
    async cancel() {
      await terminateInternal('canceled');
    },
    async dispose() {
      await terminateInternal('disposed');
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
  };
}
