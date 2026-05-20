import type { FileChunk } from '@brainstrike/db';
import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';
import type {
  EmbeddingDeviceHint,
  ProviderDimensionParameter,
  QueueAdapter,
} from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import type { EmbeddingJobQueuePort } from './enhanced-import';

interface ChunkRepository {
  update: (chunk: {
    id: string;
    embedding?: number[];
    embeddingSetId?: string;
    embeddingUpdatedAt?: string;
    embeddingHash?: string;
    updatedAt: string;
  }) => Promise<FileChunk | null>;
}

interface BrowserQueuePortOptions {
  chunkRepository: ChunkRepository | null;
  deviceHint: EmbeddingDeviceHint;
  dispatchDrainEvent?: (embeddingSetId: string | null) => void;
  dispatchProgressEvent?: (detail: QueueProgressEventDetail) => void;
  queue: QueueAdapter;
}

const logger = createLogger('FileImport:BrowserQueuePort');
const HASHER = 'sha256';

function createAbortError(): Error {
  const error = new Error('Embedding queue scheduling was aborted.');
  error.name = 'AbortError';
  return error;
}

interface ProgressTrackerState {
  failed: number;
  lastError: string | null;
  processed: number;
  totalQueued: number;
}

type ProgressTrackerDispatch = (detail: QueueProgressEventDetail) => void;

interface QueueProgressArgs {
  chunkId: string;
  elapsedMs?: number;
  embeddingSetId: string | null;
  errorMessage?: string;
  model: string;
  pending: number;
}

function createQueueProgressTracker(dispatch: ProgressTrackerDispatch) {
  const state: ProgressTrackerState = {
    totalQueued: 0,
    processed: 0,
    failed: 0,
    lastError: null,
  };

  const emit = (status: QueueProgressEventDetail['status'], args: QueueProgressArgs) => {
    const detail: QueueProgressEventDetail = {
      queue: 'embeddings',
      chunkId: args.chunkId,
      status,
      model: args.model,
      embeddingSetId: args.embeddingSetId,
      pending: Math.max(0, args.pending),
      processed: state.processed,
      failed: state.failed,
      totalQueued: state.totalQueued,
      lastError: state.lastError,
      ...(typeof args.elapsedMs === 'number' ? { elapsedMs: Math.max(0, args.elapsedMs) } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    };
    if (status === 'error') {
      logger.error('Embedding job failed', {
        chunkId: detail.chunkId,
        model: detail.model,
        embeddingSetId: detail.embeddingSetId,
        errorMessage: detail.errorMessage ?? null,
      });
    } else if (status === 'completed') {
      logger.debug('Embedding job completed', {
        chunkId: detail.chunkId,
        model: detail.model,
        embeddingSetId: detail.embeddingSetId,
        pending: detail.pending,
      });
    }
    dispatch(detail);
  };

  return {
    reset() {
      state.totalQueued = 0;
      state.processed = 0;
      state.failed = 0;
      state.lastError = null;
    },
    queued(args: QueueProgressArgs) {
      state.totalQueued += 1;
      emit('queued', args);
    },
    completed(args: QueueProgressArgs) {
      state.processed += 1;
      emit('completed', args);
    },
    failed(args: QueueProgressArgs) {
      state.failed += 1;
      state.lastError = args.errorMessage ?? state.lastError;
      emit('error', args);
    },
  };
}

export interface QueueProgressEventDetail {
  readonly chunkId: string;
  readonly elapsedMs?: number;
  readonly embeddingSetId: string | null;
  readonly errorMessage?: string;
  readonly failed: number;
  readonly lastError: string | null;
  readonly model: string;
  readonly pending: number;
  readonly processed: number;
  readonly queue: 'embeddings';
  readonly status: 'queued' | 'completed' | 'error';
  readonly totalQueued: number;
}

export function createBrowserEmbeddingQueuePort({
  queue,
  chunkRepository,
  deviceHint,
  dispatchDrainEvent = defaultDispatchDrainEvent,
  dispatchProgressEvent = defaultDispatchProgressEvent,
}: BrowserQueuePortOptions): EmbeddingJobQueuePort {
  const pendingChunks = new Set<string>();
  const progressTracker = createQueueProgressTracker(dispatchProgressEvent);

  const scheduleChunk = createChunkScheduler({
    queue,
    chunkRepository,
    deviceHint,
    pendingChunks,
    dispatchDrainEvent,
    progressTracker,
  });

  return {
    resetProgress() {
      if (pendingChunks.size > 0) {
        logger.warn('Skipping queue progress reset while jobs are still pending', {
          pending: pendingChunks.size,
        });
        return;
      }
      progressTracker.reset();
    },
    async enqueueBatch(chunks, _fileRecordId, options) {
      if (options?.signal?.aborted) {
        throw createAbortError();
      }
      const model = options?.model ?? null;
      if (!model) {
        logger.warn('Embedding queue requested without a target model', {
          chunkCount: chunks.length,
        });
        return;
      }

      const repository = chunkRepository;
      if (!repository) {
        logger.warn('Embedding queue requested without chunk repository', {
          chunkCount: chunks.length,
        });
        return;
      }

      const targetEmbeddingSetId = options?.targetEmbeddingSetId ?? null;
      const targetDimension = options?.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
      const dimensionParameter = options?.dimensionParameter ?? null;
      const provider = options?.provider ?? null;

      logger.info('Scheduling embedding batch', {
        chunkCount: chunks.length,
        model,
        targetEmbeddingSetId,
        provider,
        targetDimension,
      });

      scheduleChunksBatch(scheduleChunk, chunks, {
        model,
        repository,
        targetEmbeddingSetId,
        targetDimension,
        dimensionParameter,
        provider,
        signal: options?.signal ?? null,
      });
    },
  };
}

interface ScheduleChunkArgs {
  chunk: FileChunk;
  dimensionParameter?: ProviderDimensionParameter;
  model: string;
  provider?: EmbeddingProviderType;
  repository: ChunkRepository;
  targetDimension?: number;
  targetEmbeddingSetId: string | null;
}

interface SchedulerDependencies {
  chunkRepository: ChunkRepository | null;
  deviceHint: EmbeddingDeviceHint;
  dispatchDrainEvent: (embeddingSetId: string | null) => void;
  pendingChunks: Set<string>;
  progressTracker: ReturnType<typeof createQueueProgressTracker>;
  queue: QueueAdapter;
}

function createChunkScheduler({
  queue,
  deviceHint,
  pendingChunks,
  dispatchDrainEvent,
  progressTracker,
}: SchedulerDependencies) {
  const maybeDispatchDrain = (embeddingSetId: string | null) => {
    if (pendingChunks.size === 0) {
      logger.info('Embedding queue drained', { embeddingSetId });
      dispatchDrainEvent(embeddingSetId);
    }
  };

  return async ({
    chunk,
    model,
    targetEmbeddingSetId,
    repository,
    targetDimension,
    dimensionParameter,
    provider,
  }: ScheduleChunkArgs) => {
    if (!validateChunk(chunk, repository, model)) {
      return;
    }
    const taskContext: ChunkTaskContext = {
      queue,
      chunk,
      model,
      targetEmbeddingSetId,
      repository,
      targetDimension: targetDimension ?? DEFAULT_EMBEDDING_DIMENSION,
      dimensionParameter: dimensionParameter ?? null,
      provider: provider ?? null,
      deviceHint,
      progressTracker,
      pendingChunks,
      emitDrain: maybeDispatchDrain,
    };

    logger.debug('Queueing chunk for embedding', {
      chunkId: chunk.id,
      model,
      targetEmbeddingSetId,
      provider,
    });
    await runChunkTask(taskContext);
  };
}

interface ChunkTaskContext {
  chunk: FileChunk;
  deviceHint: EmbeddingDeviceHint;
  dimensionParameter: ProviderDimensionParameter | null;
  emitDrain: (embeddingSetId: string | null) => void;
  model: string;
  pendingChunks: Set<string>;
  progressTracker: ReturnType<typeof createQueueProgressTracker>;
  provider: EmbeddingProviderType | null;
  queue: QueueAdapter;
  repository: ChunkRepository;
  targetDimension: number;
  targetEmbeddingSetId: string | null;
}

async function runChunkTask(context: ChunkTaskContext): Promise<void> {
  const {
    queue,
    chunk,
    model,
    targetEmbeddingSetId,
    repository,
    targetDimension,
    dimensionParameter,
    provider,
    deviceHint,
    progressTracker,
    pendingChunks,
    emitDrain,
  } = context;

  pendingChunks.add(chunk.id);
  progressTracker.queued({
    chunkId: chunk.id,
    model,
    embeddingSetId: targetEmbeddingSetId,
    pending: pendingChunks.size,
  });

  const startedAt = timestamp();
  const queueOptions = {
    targetDimension,
    deviceHint,
    ...(dimensionParameter ? { dimensionParameter } : {}),
    ...(provider ? { provider } : {}),
  } as const;

  try {
    const embedding = await produceEmbedding(queue, chunk, model, queueOptions);
    await persistEmbedding({
      repository,
      chunk,
      model,
      embedding,
      targetEmbeddingSetId,
    });
    const elapsed = elapsedSince(startedAt);
    logSuccess({ chunk, model, startedAt });
    pendingChunks.delete(chunk.id);
    progressTracker.completed({
      chunkId: chunk.id,
      model,
      embeddingSetId: targetEmbeddingSetId,
      pending: pendingChunks.size,
      elapsedMs: elapsed,
    });
  } catch (error) {
    logFailure({ chunk, model, error });
    pendingChunks.delete(chunk.id);
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
    progressTracker.failed({
      chunkId: chunk.id,
      model,
      embeddingSetId: targetEmbeddingSetId,
      pending: pendingChunks.size,
      errorMessage: message,
    });
  } finally {
    emitDrain(targetEmbeddingSetId);
  }
}

interface ScheduleBatchContext {
  dimensionParameter: ProviderDimensionParameter | null;
  model: string;
  provider: EmbeddingProviderType | null;
  repository: ChunkRepository;
  signal: AbortSignal | null;
  targetDimension: number;
  targetEmbeddingSetId: string | null;
}

function scheduleChunksBatch(
  schedule: (args: ScheduleChunkArgs) => Promise<void>,
  chunks: readonly FileChunk[],
  context: ScheduleBatchContext
): void {
  for (const chunk of chunks) {
    if (context.signal?.aborted) {
      throw createAbortError();
    }
    const args: ScheduleChunkArgs = {
      chunk,
      model: context.model,
      targetEmbeddingSetId: context.targetEmbeddingSetId,
      repository: context.repository,
      targetDimension: context.targetDimension,
      ...(context.dimensionParameter ? { dimensionParameter: context.dimensionParameter } : {}),
      ...(context.provider ? { provider: context.provider } : {}),
    };
    void schedule(args);
  }
}

function validateChunk(chunk: FileChunk, repository: ChunkRepository | null, _model: string) {
  if (!repository) {
    logger.warn('Skipping embedding enqueue: chunk repository unavailable', {
      chunkId: chunk.id,
    });
    return false;
  }

  if (!chunk.content || chunk.content.length === 0) {
    logger.debug('Skipping embedding enqueue for empty chunk content', {
      chunkId: chunk.id,
      fileRecordId: chunk.fileRecordId,
    });
    return false;
  }

  return true;
}

async function produceEmbedding(
  queue: QueueAdapter,
  chunk: FileChunk,
  model: string,
  options: {
    targetDimension: number;
    deviceHint: EmbeddingDeviceHint;
    dimensionParameter?: ProviderDimensionParameter;
    provider?: EmbeddingProviderType;
  }
) {
  const resolvedTargetDimension = options.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  const request = {
    kind: 'embed',
    id: chunk.id,
    model,
    texts: [chunk.content],
    deviceHint: options.deviceHint,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.dimensionParameter ? { dimensionParameter: options.dimensionParameter } : {}),
    targetDimension: resolvedTargetDimension,
  } as const;
  const result = await queue.add(request);
  const vector = result.vectors[0];
  if (!vector) {
    logger.warn('Embedding worker returned no vector for chunk', {
      chunkId: chunk.id,
      model,
    });
    throw new Error('Embedding worker returned no vector');
  }

  return toNumericEmbedding(vector);
}

interface PersistArgs {
  chunk: FileChunk;
  embedding: number[];
  model: string;
  repository: ChunkRepository;
  targetEmbeddingSetId: string | null;
}

async function persistEmbedding({
  repository,
  chunk,
  model,
  embedding,
  targetEmbeddingSetId,
}: PersistArgs) {
  const now = new Date().toISOString();
  const embeddingHash =
    chunk.contentHash === undefined ? null : await computeEmbeddingHash(chunk.contentHash, model);

  const nextEmbeddingSetId =
    targetEmbeddingSetId ?? (chunk.embeddingSetId === undefined ? undefined : chunk.embeddingSetId);

  await repository.update({
    id: chunk.id,
    embedding,
    ...(nextEmbeddingSetId === undefined ? {} : { embeddingSetId: nextEmbeddingSetId }),
    embeddingUpdatedAt: now,
    ...(embeddingHash === null ? {} : { embeddingHash }),
    updatedAt: now,
  });
}

interface LogSuccessArgs {
  chunk: FileChunk;
  model: string;
  startedAt: number;
}

interface LogFailureArgs {
  chunk: FileChunk;
  error: unknown;
  model: string;
}

function logSuccess({ chunk, model, startedAt }: LogSuccessArgs) {
  const elapsed =
    typeof performance === 'undefined' ? 0 : Math.round(performance.now() - startedAt);
  logger.info('Updated chunk embedding from browser queue', {
    chunkId: chunk.id,
    model,
    embeddingLength: chunk.embedding?.length,
    elapsedMs: elapsed,
  });
}

function logFailure({ chunk, model, error }: LogFailureArgs) {
  logger.error('Browser queue embedding failed', {
    chunkId: chunk.id,
    model,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

function timestamp(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(timestamp() - startedAt));
}

async function computeEmbeddingHash(contentHash: string, model: string): Promise<string> {
  const payload = `${contentHash}:${model}`;
  if (typeof globalThis !== 'undefined' && 'crypto' in globalThis) {
    const cryptoObject = globalThis.crypto as Crypto | undefined;
    const subtle = cryptoObject?.subtle;
    if (subtle) {
      try {
        const data = new TextEncoder().encode(payload);
        const digest = await subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      } catch (error) {
        logger.warn('Failed to compute embedding hash via Web Crypto, falling back to Node hash', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  logger.warn('Falling back to unhashed embedding content signature', { hasher: HASHER });
  return payload;
}

function toNumericEmbedding(vector: Float32Array): number[] {
  const embedding = Array.from(vector);
  if (!embedding.every((value) => Number.isFinite(value))) {
    throw new Error('Embedding worker returned a non-finite vector');
  }
  return embedding;
}

function defaultDispatchProgressEvent(detail: QueueProgressEventDetail) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.dispatchEvent(new CustomEvent('brainstrike:queue-progress', { detail }));
  } catch (error) {
    logger.warn('Failed to dispatch queue-progress event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function defaultDispatchDrainEvent(embeddingSetId: string | null) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.dispatchEvent(
      new CustomEvent('brainstrike:queue-drained', {
        detail: { queue: 'embeddings', embeddingSetId },
      })
    );
  } catch (error) {
    logger.warn('Failed to dispatch queue-drained event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
