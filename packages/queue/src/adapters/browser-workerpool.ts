import {
  assertEmbedWorkerLifetimeError,
  assertEmbedWorkerPipelineCacheDiagnostic,
  assertEmbedWorkerTelemetrySourceClosed,
  EMBED_WORKER_INSTANCE_NAME_PREFIX,
  EMBED_WORKER_REQUEST_CONTROL_CHANNEL_SUFFIX,
  EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY,
  EMBEDDING_DEVICE_LOST_CODE,
  EmbeddingDeviceLostError,
  type EmbedWorkerLifetimeError,
  type EmbedWorkerPipelineCacheDiagnostic,
  type EmbedWorkerRequestControl,
  isEmbedWorkerRequestCancellation,
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

function readWorkerEvent(value: unknown): WorkerEvent | null {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const typeValue = record['type'];
  if (typeValue === 'progress') {
    if (
      !(typeof record['id'] === 'string' && record['id'].length > 0) ||
      (record['phase'] !== 'initializing' &&
        record['phase'] !== 'embedding' &&
        record['phase'] !== 'complete') ||
      !(
        typeof record['progress'] === 'number' &&
        Number.isFinite(record['progress']) &&
        record['progress'] >= 0 &&
        record['progress'] <= 1
      )
    ) {
      throw new Error('Embedding worker request progress event is malformed.');
    }
    return value as QueueProgressEvent;
  }
  if (typeValue === 'error') {
    if (
      !(
        typeof record['id'] === 'string' &&
        record['id'].length > 0 &&
        typeof record['message'] === 'string' &&
        record['message'].length > 0 &&
        (record['cause'] === undefined || typeof record['cause'] === 'string') &&
        (record['code'] === undefined || record['code'] === EMBEDDING_DEVICE_LOST_CODE)
      )
    ) {
      throw new Error('Embedding worker request error event is malformed.');
    }
    return value as QueueErrorEvent;
  }
  return null;
}

function assertCurrentTaskWorkerEvent(workerEvent: WorkerEvent, taskId: string): void {
  if (workerEvent.id !== taskId) {
    throw new Error('Embedding worker request event id must match the current task id.');
  }
}

function readDeviceLoss(workerEvent: WorkerEvent): EmbeddingDeviceLostError | null {
  if (workerEvent.type !== 'error' || workerEvent.code !== EMBEDDING_DEVICE_LOST_CODE) {
    return null;
  }
  return new EmbeddingDeviceLostError(workerEvent.cause ?? workerEvent.message);
}

function throwIfWorkerError(workerEvent: WorkerEvent): void {
  if (workerEvent.type === 'error') {
    throw new Error(workerEvent.message, { cause: workerEvent.cause });
  }
}

function readPipelineCacheDiagnostic(value: unknown): EmbedWorkerPipelineCacheDiagnostic | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const hasPipelineCacheDiagnostic = record['diagnostic'] === 'pipeline-cache';
  const hasDiagnosticType = record['type'] === 'diagnostic';
  if (hasPipelineCacheDiagnostic !== hasDiagnosticType) {
    throw new Error('Embedding worker request event has invalid pipeline-cache discriminators.');
  }
  if (!hasPipelineCacheDiagnostic) {
    return null;
  }
  assertEmbedWorkerPipelineCacheDiagnostic(value);
  return value;
}

const MANAGED_WORKER_SCRIPT_FRAGMENT_KEY = 'brainstrike-embedding-worker-instance';
const WORKER_LIFETIME_TELEMETRY_CHANNEL_PREFIX = 'brainstrike-embedding-worker-telemetry:';
const MISSING_PIPELINE_CACHE_DIAGNOSTIC_REASON =
  'Workerpool result arrived without a pipeline-cache source diagnostic.';
const WORKER_LIFETIME_RECOVERY_REASON =
  'Embedding worker lifetime failure required workerpool recovery.';

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
  onAbort: () => void,
  description: string
): () => void {
  if (signal === undefined) {
    return () => {};
  }
  if (signal.aborted) {
    logger.debug('Gracefully aborting worker task (%s) due to pre-aborted signal', description);
    onAbort();
    return () => {};
  }
  const abortListener = () => {
    logger.debug('Gracefully aborting worker task (%s) due to abort signal', description);
    onAbort();
  };
  signal.addEventListener('abort', abortListener, { once: true });
  return () => signal.removeEventListener('abort', abortListener);
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
  // Retain every identity assigned during this adapter lifetime. A retired worker can have
  // more than one already-queued channel event; those are valid but must not affect its
  // replacement generation. Unknown identities still fail validation visibly.
  const assignedWorkerInstanceIds = new Set<string>();
  const activeWorkerInstanceIds = new Set<string>();
  const telemetryChannelName = `${WORKER_LIFETIME_TELEMETRY_CHANNEL_PREFIX}${globalThis.crypto.randomUUID()}`;
  const telemetryChannel = new BroadcastChannel(telemetryChannelName);
  let requestControlChannel: BroadcastChannel;
  try {
    requestControlChannel = new BroadcastChannel(
      `${telemetryChannelName}${EMBED_WORKER_REQUEST_CONTROL_CHANNEL_SUFFIX}`
    );
  } catch (error) {
    telemetryChannel.close();
    throw error;
  }
  let managedChannelsClosed = false;
  const closeManagedChannels = (): void => {
    if (managedChannelsClosed) {
      return;
    }
    managedChannelsClosed = true;
    requestControlChannel.close();
    telemetryChannel.close();
  };
  const clearEmbeddingTelemetrySources = (): void => {
    for (const sourceId of embeddingTelemetrySourceIds) {
      embeddingTelemetry.removeSource(sourceId);
    }
    embeddingTelemetrySourceIds.clear();
    activeWorkerInstanceIds.clear();
  };
  const forgetManagedWorkerIdentities = (): void => {
    assignedWorkerInstanceIds.clear();
  };
  const assertManagedWorkerInstanceId = (workerInstanceId: string): void => {
    if (!assignedWorkerInstanceIds.has(workerInstanceId)) {
      throw new Error('Embedding worker telemetry identity is not assigned to this workerpool.');
    }
  };
  const assertActiveWorkerInstanceId = (workerInstanceId: string): void => {
    assertManagedWorkerInstanceId(workerInstanceId);
    if (!activeWorkerInstanceIds.has(workerInstanceId)) {
      throw new Error('Embedding worker telemetry identity is not active in this workerpool.');
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
    if (!activeWorkerInstanceIds.delete(workerInstanceId)) {
      throw new Error('Terminated embedding worker identity is not assigned to this workerpool.');
    }
    removeWorkerTelemetrySource(workerInstanceId);
  };
  const recordPipelineCacheDiagnostic = (
    diagnostic: EmbedWorkerPipelineCacheDiagnostic
  ): string => {
    assertActiveWorkerInstanceId(diagnostic.workerInstanceId);
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
      assignedWorkerInstanceIds.add(workerInstanceId);
      activeWorkerInstanceIds.add(workerInstanceId);
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
  let terminalState: 'active' | 'canceled' | 'disposed' = 'active';
  const createPool = (): Pool => workerpool.pool(workerScript, poolOptions);
  let pool: Pool;
  try {
    pool = createPool();
  } catch (error) {
    closeManagedChannels();
    throw error;
  }
  let workerLifetimeTelemetryFailure: Error | null = null;
  let workerLifetimeRecovery: Promise<void> | null = null;
  const recoverWorkerpoolAfterLifetimeError = (
    event: Pick<EmbedWorkerLifetimeError, 'message' | 'workerInstanceId'>,
    idleClosure = false
  ): void => {
    assertManagedWorkerInstanceId(event.workerInstanceId);
    if (!activeWorkerInstanceIds.has(event.workerInstanceId)) {
      return;
    }
    if (workerLifetimeRecovery !== null || terminalState !== 'active') {
      return;
    }
    const details = { reason: event.message, workerInstanceId: event.workerInstanceId };
    if (idleClosure) {
      logger.info('Idle embedding worker closed; retiring workerpool.', details);
    } else {
      embeddingTelemetry.recordFailure(WORKER_LIFETIME_RECOVERY_REASON);
      logger.error('Embedding worker lifetime failure triggered workerpool recovery.', details);
    }
    const failedPool = pool;
    workerLifetimeRecovery = (async (): Promise<void> => {
      try {
        await failedPool.terminate(true);
        clearEmbeddingTelemetrySources();
        if (terminalState === 'active') {
          pool = createPool();
        }
      } catch (error) {
        workerLifetimeTelemetryFailure = new Error(
          'Embedding workerpool recovery after a worker lifetime failure failed.',
          { cause: error }
        );
        embeddingTelemetry.recordFailure(workerLifetimeTelemetryFailure.message);
        logger.error('Embedding workerpool recovery after a lifetime failure failed.', {
          reason: error instanceof Error ? error.message : 'Unknown workerpool recovery error.',
        });
        closeManagedChannels();
        clearEmbeddingTelemetrySources();
        forgetManagedWorkerIdentities();
      } finally {
        workerLifetimeRecovery = null;
      }
    })();
  };
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
    closeManagedChannels();
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
        forgetManagedWorkerIdentities();
      }
    })();
  };
  telemetryChannel.onmessage = (event: MessageEvent<unknown>): void => {
    try {
      if (
        event.data &&
        typeof event.data === 'object' &&
        !Array.isArray(event.data) &&
        (event.data as Record<string, unknown>)['type'] === 'worker-lifetime-error'
      ) {
        assertEmbedWorkerLifetimeError(event.data);
        recoverWorkerpoolAfterLifetimeError(event.data);
        return;
      }
      if (
        event.data &&
        typeof event.data === 'object' &&
        !Array.isArray(event.data) &&
        (event.data as Record<string, unknown>)['type'] === 'telemetry-source-closed'
      ) {
        assertEmbedWorkerTelemetrySourceClosed(event.data);
        assertManagedWorkerInstanceId(event.data.workerInstanceId);
        removeWorkerTelemetrySource(event.data.workerInstanceId);
        // Web Workers emit no owner-side exit event for self.close(). Retire through
        // workerpool's public lifetime API before another request can use this slot.
        recoverWorkerpoolAfterLifetimeError(
          {
            message: 'Embedding worker closed after WebGPU device loss.',
            workerInstanceId: event.data.workerInstanceId,
          },
          activeTasks === 0
        );
        return;
      }
      const diagnostic = readPipelineCacheDiagnostic(event.data);
      if (diagnostic === null || diagnostic.id !== undefined) {
        throw new Error(
          'Embedding worker-lifetime telemetry requires an id-less pipeline-cache diagnostic.'
        );
      }
      assertManagedWorkerInstanceId(diagnostic.workerInstanceId);
      if (!activeWorkerInstanceIds.has(diagnostic.workerInstanceId)) {
        return;
      }
      recordPipelineCacheDiagnostic(diagnostic);
    } catch (error) {
      failWorkerLifetimeTelemetry(error);
    }
  };

  let paused = false;
  const resumeWaiters: Array<() => void> = [];
  const cancelWaiters: Array<() => void> = [];
  const emitter = new ProgressEmitter<WorkerEvent>();
  let activeTasks = 0;
  const prepareTerminalRetirements = new Set<() => void>();
  let issuingPhysicalTermination = false;
  let physicalRetirement: Promise<void> | null = null;
  let termination: Promise<void> | null = null;
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

  const joinPhysicalFailure = async (failure: unknown): Promise<unknown> => {
    try {
      await physicalRetirement;
    } catch (retirementError) {
      if (retirementError !== failure) {
        return new AggregateError(
          [failure, retirementError],
          'Embedding execution and physical retirement failed'
        );
      }
    }
    return failure;
  };

  const execute = async (
    task: TaskPayload,
    opts?: QueueAddOptions | QueueAddBulkOptions
  ): Promise<QueueResult> => {
    if (paused) {
      await waitForResume();
    }
    const recovery = workerLifetimeRecovery;
    if (recovery !== null) {
      await recovery;
      assertAcceptingWork();
    }
    const signal = (opts as QueueAddOptions | undefined)?.signal;
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      onTaskError(task, now(), reason);
      throw reason;
    }
    assertAcceptingWork();
    let abortRequested = false;
    const postRequestControl = (type: EmbedWorkerRequestControl['type']): void => {
      if (managedChannelsClosed) {
        return;
      }
      requestControlChannel.postMessage({ id: task.id, type } satisfies EmbedWorkerRequestControl);
    };
    const requestAbort = (): void => {
      abortRequested = true;
      postRequestControl('cancel-request');
    };
    let cancelRebroadcastedAfterWorkerEvent = false;
    const { promise, startedAt, telemetrySource, prepareForRetirement, isTerminalCancellation } =
      createExecutionPromise(task, () => {
        // BroadcastChannel does not retain messages posted before a newly spawned worker
        // subscribes. Re-send once after its first event proves the channel is ready.
        if (abortRequested && !cancelRebroadcastedAfterWorkerEvent) {
          cancelRebroadcastedAfterWorkerEvent = true;
          postRequestControl('cancel-request');
        }
      });
    const detachAbort = attachAbort(signal, requestAbort, task.id);
    const prepareOwnedRetirement = (): void => {
      if (signal?.aborted) {
        prepareForRetirement();
      }
    };
    prepareTerminalRetirements.add(prepareOwnedRetirement);
    activeTasks += 1;
    try {
      const result = await promise;
      await physicalRetirement;
      signal?.throwIfAborted();
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
      // Ordinary abort stays cooperative. Terminal owner cancellation uses the
      // exact rejection emitted by our public vendor cancel, then joins the pool.
      const executionFailure: unknown =
        signal?.aborted &&
        (isEmbedWorkerRequestCancellation(error, task.id) || isTerminalCancellation(error))
          ? signal.reason
          : error;
      const failure = await joinPhysicalFailure(executionFailure);
      onTaskError(task, startedAt, failure);
      throw failure;
    } finally {
      prepareTerminalRetirements.delete(prepareOwnedRetirement);
      detachAbort();
      if (abortRequested) {
        postRequestControl('clear-request-control');
      }
      activeTasks = Math.max(activeTasks - 1, 0);
      notifyDrain();
      notifyCancel();
    }
  };

  const createExecutionPromise = (task: TaskPayload, onWorkerEvent: () => void) => {
    const startedAt = now();
    const request = toWorkerRequest(task);
    const telemetrySource: { current: string | null } = { current: null };
    let deviceLoss: EmbeddingDeviceLostError | null = null;
    const telemetryError: { current: Error | null } = { current: null };
    let rejectTelemetryError!: (error: Error) => void;
    const telemetryFailure = new Promise<never>((_resolve, reject) => {
      rejectTelemetryError = reject;
    });
    let cancelable: WorkerPoolPromise<QueueResult> | null = null;
    cancelable = pool.exec('runEmbedding', [request], {
      on: (event: unknown) => {
        try {
          onWorkerEvent();
          const diagnostic = readPipelineCacheDiagnostic(event);
          if (diagnostic) {
            if (diagnostic.id !== task.id) {
              throw new Error(
                'Embedding worker request telemetry id must match the current task id.'
              );
            }
            telemetrySource.current = recordPipelineCacheDiagnostic(diagnostic);
            return;
          }
          const workerEvent = readWorkerEvent(event);
          if (!workerEvent) {
            throw new Error('Embedding worker request emitted an unsupported event.');
          }
          assertCurrentTaskWorkerEvent(workerEvent, task.id);
          emitter.emit(workerEvent);
          const deviceFailure = readDeviceLoss(workerEvent);
          if (deviceFailure) {
            deviceLoss = deviceFailure;
            return;
          }
          throwIfWorkerError(workerEvent);
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
    let executionPending = true;
    let captureTerminalRejection = false;
    let terminalCancellation: unknown;
    const checkedExecution = cancelable.then(
      (result) => {
        executionPending = false;
        if (telemetryError.current) {
          throw telemetryError.current;
        }
        if (deviceLoss) {
          throw deviceLoss;
        }
        return result;
      },
      (error: unknown) => {
        if (issuingPhysicalTermination && captureTerminalRejection) {
          terminalCancellation = error;
        }
        executionPending = false;
        if (telemetryError.current) {
          throw telemetryError.current;
        }
        if (deviceLoss) {
          throw deviceLoss;
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

    return {
      cancelable,
      isTerminalCancellation: (error: unknown): boolean =>
        terminalCancellation !== undefined &&
        error === terminalCancellation &&
        telemetryError.current === null,
      prepareForRetirement: (): void => {
        captureTerminalRejection = executionPending;
      },
      promise,
      startedAt,
      telemetrySource,
    };
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

  const terminatePool = (): ReturnType<Pool['terminate']> => {
    issuingPhysicalTermination = true;
    try {
      // Capture only this synchronous vendor call's rejections of already-aborted work.
      // Per-task cancel would re-enter worker cleanup and create a minWorkers replacement.
      return pool.terminate(true);
    } finally {
      issuingPhysicalTermination = false;
    }
  };

  const terminateInternal = (nextState: 'canceled' | 'disposed'): Promise<void> => {
    if (termination) {
      return termination;
    }
    terminalState = nextState;
    paused = true;
    logger.debug(`Workerpool adapter ${nextState === 'canceled' ? 'canceling' : 'disposing'}`, {
      activeTasks,
    });
    const physical = Promise.withResolvers<void>();
    physicalRetirement = physical.promise;
    // Observed here as well as by executions; the retained join still rejects.
    physical.promise.catch(() => undefined);
    const completed = Promise.withResolvers<void>();
    termination = completed.promise.finally(() => {
      closeManagedChannels();
      clearEmbeddingTelemetrySources();
      forgetManagedWorkerIdentities();
    });
    // Retain both joins before invoking synchronous vendor cancellation callbacks.
    void (async () => {
      const failures: unknown[] = [];
      for (const prepare of prepareTerminalRetirements) {
        try {
          prepare();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await terminatePool();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        const failure =
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, 'Embedding pool retirement failed');
        physical.reject(failure);
      } else {
        physical.resolve();
      }
      // Execution joins only physical, never this full task-accounting join.
      if (activeTasks > 0) {
        await new Promise<void>((resolve) => {
          cancelWaiters.push(resolve);
        });
      }
      await physical.promise;
      logger.debug(`Workerpool adapter ${nextState}`);
    })().then(completed.resolve, completed.reject);
    return termination;
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
