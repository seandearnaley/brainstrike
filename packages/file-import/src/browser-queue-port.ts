import type { FileChunk } from '@brainstrike/db';
import type {
  EmbeddingProviderType,
  IndexingEmbeddingJobChunk,
} from '@brainstrike/indexing-contract';
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

interface BrowserEmbeddingJobChunk extends IndexingEmbeddingJobChunk {
  readonly content: string;
  readonly embedding?: number[] | null;
  readonly fileRecordId?: string | null;
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
    failed: 0,
    lastError: null,
    processed: 0,
    totalQueued: 0,
  };

  const emit = (status: QueueProgressEventDetail['status'], args: QueueProgressArgs) => {
    const detail: QueueProgressEventDetail = {
      chunkId: args.chunkId,
      embeddingSetId: args.embeddingSetId,
      failed: state.failed,
      lastError: state.lastError,
      model: args.model,
      pending: Math.max(0, args.pending),
      processed: state.processed,
      queue: 'embeddings',
      status,
      totalQueued: state.totalQueued,
      ...(typeof args.elapsedMs === 'number' ? { elapsedMs: Math.max(0, args.elapsedMs) } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    };
    if (status === 'error') {
      logger.error('Embedding job failed', {
        chunkId: detail.chunkId,
        embeddingSetId: detail.embeddingSetId,
        errorMessage: detail.errorMessage ?? null,
        model: detail.model,
      });
    } else if (status === 'completed') {
      logger.debug('Embedding job completed', {
        chunkId: detail.chunkId,
        embeddingSetId: detail.embeddingSetId,
        model: detail.model,
        pending: detail.pending,
      });
    }
    dispatch(detail);
  };

  return {
    completed(args: QueueProgressArgs) {
      state.processed += 1;
      emit('completed', args);
    },
    failed(args: QueueProgressArgs) {
      state.failed += 1;
      state.lastError = args.errorMessage ?? state.lastError;
      emit('error', args);
    },
    queued(args: QueueProgressArgs) {
      state.totalQueued += 1;
      emit('queued', args);
    },
    reset() {
      state.totalQueued = 0;
      state.processed = 0;
      state.failed = 0;
      state.lastError = null;
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
    chunkRepository,
    deviceHint,
    dispatchDrainEvent,
    pendingChunks,
    progressTracker,
    queue,
  });

  return {
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
        provider,
        targetDimension,
        targetEmbeddingSetId,
      });

      scheduleChunksBatch(scheduleChunk, chunks, {
        dimensionParameter,
        model,
        provider,
        repository,
        signal: options?.signal ?? null,
        targetDimension,
        targetEmbeddingSetId,
      });
    },
    resetProgress() {
      if (pendingChunks.size > 0) {
        logger.warn('Skipping queue progress reset while jobs are still pending', {
          pending: pendingChunks.size,
        });
        return;
      }
      progressTracker.reset();
    },
  };
}

interface ScheduleChunkArgs {
  chunk: BrowserEmbeddingJobChunk;
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
      chunk,
      deviceHint,
      dimensionParameter: dimensionParameter ?? null,
      emitDrain: maybeDispatchDrain,
      model,
      pendingChunks,
      progressTracker,
      provider: provider ?? null,
      queue,
      repository,
      targetDimension: targetDimension ?? DEFAULT_EMBEDDING_DIMENSION,
      targetEmbeddingSetId,
    };

    logger.debug('Queueing chunk for embedding', {
      chunkId: chunk.id,
      model,
      provider,
      targetEmbeddingSetId,
    });
    await runChunkTask(taskContext);
  };
}

interface ChunkTaskContext {
  chunk: BrowserEmbeddingJobChunk;
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
    embeddingSetId: targetEmbeddingSetId,
    model,
    pending: pendingChunks.size,
  });

  const startedAt = timestamp();
  const queueOptions = {
    deviceHint,
    targetDimension,
    ...(dimensionParameter ? { dimensionParameter } : {}),
    ...(provider ? { provider } : {}),
  } as const;

  try {
    const embedding = await produceEmbedding(queue, chunk, model, queueOptions);
    await persistEmbedding({
      chunk,
      embedding,
      model,
      repository,
      targetEmbeddingSetId,
    });
    const elapsed = elapsedSince(startedAt);
    logSuccess({ chunk, model, startedAt });
    pendingChunks.delete(chunk.id);
    progressTracker.completed({
      chunkId: chunk.id,
      elapsedMs: elapsed,
      embeddingSetId: targetEmbeddingSetId,
      model,
      pending: pendingChunks.size,
    });
  } catch (error) {
    logFailure({ chunk, error, model });
    pendingChunks.delete(chunk.id);
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
    progressTracker.failed({
      chunkId: chunk.id,
      embeddingSetId: targetEmbeddingSetId,
      errorMessage: message,
      model,
      pending: pendingChunks.size,
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
  chunks: readonly IndexingEmbeddingJobChunk[],
  context: ScheduleBatchContext
): void {
  for (const chunk of chunks) {
    if (context.signal?.aborted) {
      throw createAbortError();
    }
    const sourceChunk = requireBrowserEmbeddingJobChunk(chunk);
    const args: ScheduleChunkArgs = {
      chunk: sourceChunk,
      model: context.model,
      repository: context.repository,
      targetDimension: context.targetDimension,
      targetEmbeddingSetId: context.targetEmbeddingSetId,
      ...(context.dimensionParameter ? { dimensionParameter: context.dimensionParameter } : {}),
      ...(context.provider ? { provider: context.provider } : {}),
    };
    void schedule(args);
  }
}

function requireBrowserEmbeddingJobChunk(
  chunk: IndexingEmbeddingJobChunk
): BrowserEmbeddingJobChunk {
  if (typeof chunk.content !== 'string') {
    throw new Error('Browser embedding queue requires chunk content.');
  }
  return chunk as BrowserEmbeddingJobChunk;
}

function validateChunk(
  chunk: BrowserEmbeddingJobChunk,
  repository: ChunkRepository | null,
  _model: string
) {
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
  chunk: BrowserEmbeddingJobChunk,
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
    deviceHint: options.deviceHint,
    id: chunk.id,
    kind: 'embed',
    model,
    texts: [chunk.content],
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
  chunk: BrowserEmbeddingJobChunk;
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
  const contentHash = chunk.contentHash ?? null;
  const embeddingHash =
    contentHash === null ? null : await computeEmbeddingHash(contentHash, model);

  const nextEmbeddingSetId = targetEmbeddingSetId ?? chunk.embeddingSetId ?? undefined;

  await repository.update({
    embedding,
    id: chunk.id,
    ...(nextEmbeddingSetId === undefined ? {} : { embeddingSetId: nextEmbeddingSetId }),
    embeddingUpdatedAt: now,
    ...(embeddingHash === null ? {} : { embeddingHash }),
    updatedAt: now,
  });
}

interface LogSuccessArgs {
  chunk: BrowserEmbeddingJobChunk;
  model: string;
  startedAt: number;
}

interface LogFailureArgs {
  chunk: BrowserEmbeddingJobChunk;
  error: unknown;
  model: string;
}

function logSuccess({ chunk, model, startedAt }: LogSuccessArgs) {
  const elapsed =
    typeof performance === 'undefined' ? 0 : Math.round(performance.now() - startedAt);
  logger.info('Updated chunk embedding from browser queue', {
    chunkId: chunk.id,
    elapsedMs: elapsed,
    embeddingLength: chunk.embedding?.length,
    model,
  });
}

function logFailure({ chunk, model, error }: LogFailureArgs) {
  logger.error('Browser queue embedding failed', {
    chunkId: chunk.id,
    error: error instanceof Error ? error.message : String(error),
    model,
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
        detail: { embeddingSetId, queue: 'embeddings' },
      })
    );
  } catch (error) {
    logger.warn('Failed to dispatch queue-drained event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
