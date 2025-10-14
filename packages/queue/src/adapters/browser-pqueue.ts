import {
  computeInitialBatchSize,
  type EmbeddingDType,
  l2Normalize,
  truncateVector,
  vectorsFromPipelineOutput,
} from '@brainstrike/embedding-worker';
import { createLogger } from '@brainstrike/utils';
import type { FeatureExtractionPipeline, Tensor } from '@huggingface/transformers';
import type { QueueAddOptions as PQueueAddOptions } from 'p-queue';
import PQueue from 'p-queue';
import { emitQueueTelemetry } from '../telemetry';
import type {
  QueueAdapter,
  QueueAddOptions,
  QueueErrorEvent,
  QueueProgressEvent,
  QueueResult,
  TaskPayload,
} from '../types';
import { ProgressEmitter } from '../util';

const logger = createLogger('BrowserPQueueAdapter');

type WorkerEvent = QueueProgressEvent | QueueErrorEvent;

const DEFAULT_DTYPE: EmbeddingDType = 'fp16';

export type PQueueAdapterOptions = {
  readonly concurrency?: number;
};

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function calculateElapsed(startedAt: number): number {
  return Math.round(now() - startedAt);
}

export function createPQueueAdapter(options: PQueueAdapterOptions = {}): QueueAdapter {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));
  const queue = new PQueue({ concurrency, autoStart: true });
  const emitter = new ProgressEmitter<WorkerEvent>();

  const emitTelemetry = (
    event: 'enqueue' | 'complete' | 'error',
    task: TaskPayload,
    startedAt: number,
    errorMessage?: string
  ) => {
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'pqueue',
      event,
      taskId: task.id,
      model: task.model,
      elapsedMs: event === 'enqueue' ? undefined : calculateElapsed(startedAt),
      pending: queue.pending,
      errorMessage,
      metadata: { queued: queue.size, running: queue.pending },
    });
  };

  const addTask = async (task: TaskPayload, opts?: QueueAddOptions): Promise<QueueResult> => {
    const startedAt = now();
    emitTelemetry('enqueue', task, startedAt);
    const queueOptions: Partial<PQueueAddOptions> = buildQueueOptions(opts);

    try {
      const result = await queue.add(() => embedOnMainThread(task, emitter), queueOptions);
      if (result === undefined) {
        throw new Error('Fallback embedding returned no result');
      }
      emitTelemetry('complete', task, startedAt);
      logCompletion(task, startedAt, queue);
      return result;
    } catch (error) {
      emitTelemetry(
        'error',
        task,
        startedAt,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  };

  return {
    add: addTask,
    addBulk(tasks, options) {
      const sharedOptions: QueueAddOptions | undefined =
        options?.priority !== undefined ? { priority: options.priority } : undefined;
      return Promise.all(tasks.map((task) => addTask(task, sharedOptions)));
    },
    onProgress(listener) {
      return emitter.add(listener);
    },
    pause() {
      queue.pause();
    },
    resume() {
      queue.start();
    },
    async drain() {
      await queue.onIdle();
    },
  };
}

function buildQueueOptions(opts?: QueueAddOptions): Partial<PQueueAddOptions> {
  return {
    ...(opts?.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

async function embedOnMainThread(
  task: TaskPayload,
  emitter: ProgressEmitter<WorkerEvent>
): Promise<QueueResult> {
  if (task.kind !== 'embed') {
    throw new Error(`Unsupported fallback task: ${task.kind}`);
  }

  const embedTask = task;
  const total = embedTask.texts.length;
  if (total === 0) {
    return buildEmptyResult(embedTask);
  }

  emitter.emit({
    type: 'progress',
    id: embedTask.id,
    phase: 'initializing',
    progress: 0,
  });

  const embedStarted = now();
  const transformers = await loadTransformers();
  const extractor = await getEmbedder(embedTask.model, embedTask.dtype);
  const batchSize = computeInitialBatchSize(total, embedTask.maxBatchSize);

  try {
    const vectors = await runBatchEmbedding({
      task: embedTask,
      batchSize,
      extractor,
      emitter,
      tensorCtor: transformers.Tensor,
      total,
    });

    emitter.emit({
      type: 'progress',
      id: embedTask.id,
      phase: 'complete',
      progress: 1,
    });

    return buildCompletedResult(embedTask, vectors, batchSize, embedStarted);
  } catch (error) {
    emitter.emit({
      type: 'error',
      id: embedTask.id,
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
    throw error;
  }
}

type TransformersModule = typeof import('@huggingface/transformers');

const embedderCache = new Map<string, Promise<FeatureExtractor>>();
let transformersModule: Promise<TransformersModule> | undefined;

async function loadTransformers(): Promise<TransformersModule> {
  if (transformersModule === undefined) {
    transformersModule = import('@huggingface/transformers');
  }
  return transformersModule;
}

type FeatureExtractor = FeatureExtractionPipeline &
  ((
    inputs: string | readonly string[],
    options?: { readonly pooling?: 'mean' | 'max' | 'cls'; readonly normalize?: boolean }
  ) => Promise<unknown>);

async function getEmbedder(model: string, dtype?: EmbeddingDType): Promise<FeatureExtractor> {
  const cacheKey = `${model}|${dtype ?? DEFAULT_DTYPE}`;
  const cached = embedderCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const loader = (async () => {
    const transformers = await loadTransformers();
    transformers.env.allowRemoteModels = transformers.env.allowRemoteModels ?? true;
    const pipelineFn = transformers.pipeline as typeof import('@huggingface/transformers').pipeline;
    const result = (await pipelineFn('feature-extraction', model, {
      device: 'wasm',
      dtype: dtype ?? DEFAULT_DTYPE,
    })) as FeatureExtractor;
    return result;
  })();

  embedderCache.set(cacheKey, loader);
  return loader;
}

function convertTensorToVectors(tensor: Tensor, truncateDim?: number): Float32Array[] {
  const dims = tensor.dims;
  const data = tensor.data as ArrayLike<number>;
  if (dims.length === 1) {
    return [truncateVector(l2Normalize(cloneValues(data)), truncateDim)];
  }
  if (dims.length === 2) {
    const [batch, width] = dims as [number, number];
    const typed = cloneValues(data);
    const vectors: Float32Array[] = [];
    for (let row = 0; row < batch; row += 1) {
      const start = row * width;
      const normalized = l2Normalize(new Float32Array(typed.subarray(start, start + width)));
      vectors.push(truncateVector(normalized, truncateDim));
    }
    return vectors;
  }
  const flattened = Float32Array.from(tensor.tolist().flat(Number.POSITIVE_INFINITY) as number[]);
  return [truncateVector(l2Normalize(flattened), truncateDim)];
}

function cloneValues(values: ArrayLike<number>): Float32Array {
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    result[index] = raw === undefined ? 0 : Number(raw);
  }
  return result;
}

function logCompletion(task: TaskPayload, startedAt: number, queue: PQueue): void {
  logger.info('Browser fallback embedding complete', {
    taskId: task.id,
    model: task.model,
    elapsedMs: calculateElapsed(startedAt),
    pending: queue.pending,
    queued: queue.size,
  });
  if (queue.pending === 0 && queue.size === 0) {
    logger.debug('Browser fallback queue drained');
  }
}
type EmbedTaskPayload = TaskPayload & { kind: 'embed' };

type RunBatchArgs = {
  readonly task: EmbedTaskPayload;
  readonly batchSize: number;
  readonly extractor: FeatureExtractor;
  readonly emitter: ProgressEmitter<WorkerEvent>;
  readonly tensorCtor: TransformersModule['Tensor'];
  readonly total: number;
};

async function runBatchEmbedding({
  task,
  batchSize,
  extractor,
  emitter,
  tensorCtor,
  total,
}: RunBatchArgs): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];

  for (let startIndex = 0; startIndex < total; startIndex += batchSize) {
    const endIndex = Math.min(total, startIndex + batchSize);
    const slice = task.texts.slice(startIndex, endIndex);
    const rawOutput = await extractor(slice, { pooling: 'mean', normalize: false });
    const vectorsFromBatch =
      rawOutput instanceof tensorCtor
        ? convertTensorToVectors(rawOutput, task.truncateDim)
        : vectorsFromPipelineOutput(rawOutput, task.truncateDim);
    if (vectorsFromBatch.length === 0) {
      throw new Error('Fallback embedding pipeline produced no vectors');
    }
    vectors.push(...vectorsFromBatch);
    emitter.emit({
      type: 'progress',
      id: task.id,
      phase: 'embedding',
      progress: Math.min(1, endIndex / Math.max(1, total)),
    });
  }

  return vectors;
}

function buildEmptyResult(task: EmbedTaskPayload): QueueResult {
  return {
    type: 'result',
    id: task.id,
    vectors: [],
    metadata: {
      model: task.model,
      device: 'wasm',
      dtype: task.dtype ?? DEFAULT_DTYPE,
      batchSize: 0,
      elapsedMs: 0,
      fallbackApplied: true,
      dimensions: task.truncateDim ?? 0,
    },
  };
}

function buildCompletedResult(
  task: EmbedTaskPayload,
  vectors: readonly Float32Array[],
  batchSize: number,
  startedAt: number
): QueueResult {
  return {
    type: 'result',
    id: task.id,
    vectors,
    metadata: {
      model: task.model,
      device: 'wasm',
      dtype: task.dtype ?? DEFAULT_DTYPE,
      batchSize,
      elapsedMs: calculateElapsed(startedAt),
      fallbackApplied: true,
      dimensions: vectors[0]?.length ?? task.truncateDim ?? 0,
    },
  };
}
