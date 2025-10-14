import type { FileChunk } from '@brainstrike/db';
import type { QueueAdapter } from '@brainstrike/queue';
import { createLogger } from '@brainstrike/utils';
import type { EmbeddingJobQueuePort } from './enhanced-import';

type ChunkRepository = {
  update: (chunk: {
    id: string;
    embedding?: number[];
    embeddingSetId?: string;
    embeddingUpdatedAt?: string;
    embeddingHash?: string;
    updatedAt: string;
  }) => Promise<FileChunk | null>;
};

type BrowserQueuePortOptions = {
  queue: QueueAdapter;
  chunkRepository: ChunkRepository | null;
  dispatchDrainEvent?: (embeddingSetId: string | null) => void;
};

const logger = createLogger('FileImport:BrowserQueuePort');

const HASHER = 'sha256';

export function createBrowserEmbeddingQueuePort({
  queue,
  chunkRepository,
  dispatchDrainEvent = defaultDispatchDrainEvent,
}: BrowserQueuePortOptions): EmbeddingJobQueuePort {
  const pendingChunks = new Set<string>();

  const scheduleChunk = createChunkScheduler({
    queue,
    chunkRepository,
    pendingChunks,
    dispatchDrainEvent,
  });

  return {
    async enqueueBatch(chunks, _fileRecordId, options) {
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
      for (const chunk of chunks) {
        void scheduleChunk({ chunk, model, targetEmbeddingSetId, repository });
      }
    },
  };
}

type ScheduleChunkArgs = {
  chunk: FileChunk;
  model: string;
  targetEmbeddingSetId: string | null;
  repository: ChunkRepository;
};

type SchedulerDependencies = {
  queue: QueueAdapter;
  chunkRepository: ChunkRepository | null;
  pendingChunks: Set<string>;
  dispatchDrainEvent: (embeddingSetId: string | null) => void;
};

function createChunkScheduler({ queue, pendingChunks, dispatchDrainEvent }: SchedulerDependencies) {
  const maybeDispatchDrain = (embeddingSetId: string | null) => {
    if (pendingChunks.size === 0) {
      dispatchDrainEvent(embeddingSetId);
    }
  };

  return async ({ chunk, model, targetEmbeddingSetId, repository }: ScheduleChunkArgs) => {
    if (!validateChunk(chunk, repository, model)) {
      return;
    }

    pendingChunks.add(chunk.id);
    const startedAt = timestamp();

    try {
      const embedding = await produceEmbedding(queue, chunk, model);
      await persistEmbedding({
        repository,
        chunk,
        model,
        embedding,
        targetEmbeddingSetId,
      });
      logSuccess({ chunk, model, startedAt });
    } catch (error) {
      logFailure({ chunk, model, error });
    } finally {
      pendingChunks.delete(chunk.id);
      maybeDispatchDrain(targetEmbeddingSetId);
    }
  };
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

async function produceEmbedding(queue: QueueAdapter, chunk: FileChunk, model: string) {
  const result = await queue.add({
    kind: 'embed',
    id: chunk.id,
    model,
    texts: [chunk.content],
    deviceHint: 'auto',
  });
  const vector = result.vectors[0];
  if (!vector) {
    logger.warn('Embedding worker returned no vector for chunk', {
      chunkId: chunk.id,
      model,
    });
    throw new Error('Embedding worker returned no vector');
  }

  return Array.from(vector);
}

type PersistArgs = {
  repository: ChunkRepository;
  chunk: FileChunk;
  model: string;
  embedding: number[];
  targetEmbeddingSetId: string | null;
};

async function persistEmbedding({
  repository,
  chunk,
  model,
  embedding,
  targetEmbeddingSetId,
}: PersistArgs) {
  const now = new Date().toISOString();
  const embeddingHash =
    chunk.contentHash !== undefined ? await computeEmbeddingHash(chunk.contentHash, model) : null;

  const nextEmbeddingSetId =
    targetEmbeddingSetId ?? (chunk.embeddingSetId !== undefined ? chunk.embeddingSetId : undefined);

  await repository.update({
    id: chunk.id,
    embedding,
    ...(nextEmbeddingSetId !== undefined ? { embeddingSetId: nextEmbeddingSetId } : {}),
    embeddingUpdatedAt: now,
    ...(embeddingHash !== null ? { embeddingHash } : {}),
    updatedAt: now,
  });
}

type LogSuccessArgs = {
  chunk: FileChunk;
  model: string;
  startedAt: number;
};

type LogFailureArgs = {
  chunk: FileChunk;
  model: string;
  error: unknown;
};

function logSuccess({ chunk, model, startedAt }: LogSuccessArgs) {
  const elapsed =
    typeof performance !== 'undefined' ? Math.round(performance.now() - startedAt) : 0;
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
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
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
