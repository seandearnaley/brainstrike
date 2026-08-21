import type {
  EmbeddingProviderType,
  IndexingEmbeddingJobChunk,
  IndexingEmbeddingJobQueueBatchOptions,
  IndexingEmbeddingJobQueuePort,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import {
  buildEmbeddingJobInputHashes,
  buildEmbedJobDedupeKey,
  STANDARD_EMBEDDING_DIMENSION,
} from '@brainstrike/indexing-contract';

interface DurableEmbeddingJobPayload {
  readonly chunkId: string;
  readonly dimensionParameter: ProviderDimensionParameter | null;
  readonly embeddingInputHash: string;
  readonly embeddingSetId: string | null;
  readonly expectedDimension: number;
  readonly fileRecordId: string;
  readonly modelKey: string;
  readonly provider: EmbeddingProviderType | null;
  readonly sourceContentHash: string;
}

interface DurableEmbeddingJobEnqueueParams {
  readonly dedupeKey: string;
  readonly jobType: 'embed_chunk';
  readonly payload: DurableEmbeddingJobPayload;
  readonly queue: 'embeddings';
}

export interface DurableEmbeddingJobQueue {
  enqueueBatch: (params: DurableEmbeddingJobEnqueueParams[]) => Promise<unknown>;
}

export interface EmbeddingJobQueuePortConfig<TTransaction = unknown> {
  readonly createQueue: (executor: TTransaction) => DurableEmbeddingJobQueue;
  readonly db: TTransaction;
  readonly defaultExpectedDimension?: number;
}

function createAbortError(): Error {
  const error = new Error('Embedding queue scheduling was aborted.');
  error.name = 'AbortError';
  return error;
}

function requireNonEmptyString(value: string | null | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function resolveExecutor<TTransaction>(
  db: TTransaction,
  options?: IndexingEmbeddingJobQueueBatchOptions<TTransaction>
): TTransaction {
  return options?.transaction ?? db;
}

function resolveEmbeddingSetId(
  chunk: IndexingEmbeddingJobChunk,
  options?: IndexingEmbeddingJobQueueBatchOptions<unknown>
): string | null {
  return options?.targetEmbeddingSetId ?? chunk.embeddingSetId ?? null;
}

export function createEmbeddingJobQueuePort<TTransaction = unknown>({
  db,
  createQueue,
  defaultExpectedDimension = STANDARD_EMBEDDING_DIMENSION,
}: EmbeddingJobQueuePortConfig<TTransaction>): IndexingEmbeddingJobQueuePort<TTransaction> {
  return {
    async enqueueBatch(chunks, fileRecordId, options) {
      if (options?.signal?.aborted) {
        throw createAbortError();
      }

      const modelKey = requireNonEmptyString(
        options?.model,
        'Cannot enqueue embedding jobs without a model key.'
      );
      const executor = resolveExecutor(db, options);
      const queue = createQueue(executor);
      const expectedDimension = options?.targetDimension ?? defaultExpectedDimension;
      const provider = options?.provider ?? null;
      const dimensionParameter = options?.dimensionParameter ?? null;
      const identities = chunks.map((chunk) => {
        if (options?.signal?.aborted) {
          throw createAbortError();
        }

        const chunkId = requireNonEmptyString(
          chunk.id,
          'Cannot enqueue embedding job for chunk without id.'
        );
        const contentHash = requireNonEmptyString(
          chunk.contentHash,
          'Cannot enqueue embedding job for chunk without content hash.'
        );
        const embeddingSetId = resolveEmbeddingSetId(chunk, options);
        return { chunkId, contentHash, embeddingSetId };
      });
      const embeddingInputHashes = await buildEmbeddingJobInputHashes(
        identities.map(({ contentHash }) => contentHash),
        modelKey,
        provider
      );
      if (options?.signal?.aborted) {
        throw createAbortError();
      }
      const enqueueParams = identities.map<DurableEmbeddingJobEnqueueParams>(
        ({ chunkId, contentHash, embeddingSetId }, index) => {
          const embeddingInputHash = embeddingInputHashes[index];
          if (!embeddingInputHash) {
            throw new Error(`Missing embedding input hash for chunk '${chunkId}'.`);
          }
          return {
            dedupeKey: buildEmbedJobDedupeKey(chunkId, embeddingSetId, contentHash),
            jobType: 'embed_chunk',
            payload: {
              chunkId,
              dimensionParameter,
              embeddingInputHash,
              embeddingSetId,
              expectedDimension,
              fileRecordId,
              modelKey,
              provider,
              sourceContentHash: contentHash,
            },
            queue: 'embeddings',
          };
        }
      );

      await queue.enqueueBatch(enqueueParams);
    },
  };
}
