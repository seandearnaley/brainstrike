import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import {
  buildEmbeddingJobInputHashes,
  buildEmbedJobDedupeKey,
} from '@brainstrike/indexing-contract';
import type { FileChunkInsert } from './models/file-chunk.js';
import { type EnqueueParams, JobQueue } from './queue/job-queue.js';
import { FileChunkRepository } from './repositories/file-chunk-repository.js';
import type { IDatabase } from './repositories/interfaces.js';

export interface InsertChunksAndEnqueueEmbeddingJobsArgs {
  readonly chunks: readonly FileChunkInsert[];
  readonly dimensionParameter?: ProviderDimensionParameter | null;
  readonly fileRecordId: string;
  readonly model: string;
  readonly provider?: EmbeddingProviderType | null;
  readonly targetDimension: number;
  readonly targetEmbeddingSetId?: string | null;
}

function requireNonEmptyString(value: string | null | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function assertPositiveInteger(value: number, message: string): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(message);
  }
}

async function buildEmbeddingJobParams(
  args: InsertChunksAndEnqueueEmbeddingJobsArgs
): Promise<EnqueueParams[]> {
  const modelKey = requireNonEmptyString(
    args.model,
    'Cannot enqueue embedding jobs without a model key.'
  );
  assertPositiveInteger(
    args.targetDimension,
    'Cannot enqueue embedding jobs without a positive target dimension.'
  );
  const embeddingSetId = args.targetEmbeddingSetId ?? null;
  const provider = args.provider ?? null;
  const dimensionParameter = args.dimensionParameter ?? null;

  const embeddingInputHashes = await buildEmbeddingJobInputHashes(
    args.chunks.map(({ contentHash }) => contentHash),
    modelKey,
    provider
  );

  return args.chunks.map((chunk, index) => {
    const chunkId = requireNonEmptyString(
      chunk.id,
      'Cannot enqueue embedding job for chunk without id.'
    );
    if (chunk.fileRecordId !== args.fileRecordId) {
      throw new Error(
        `Cannot enqueue embedding job for chunk '${chunkId}' with mismatched file record id.`
      );
    }
    const embeddingInputHash = embeddingInputHashes[index];
    if (!embeddingInputHash) {
      throw new Error(`Missing embedding input hash for chunk '${chunkId}'.`);
    }
    return {
      // Canonical embed-job key, shared with the @brainstrike/pipeline enqueue
      // port. Never recover chunk/set identity by splitting this key — read
      // job_queue.chunk_id / job_queue.embedding_set_id (see BST-1214).
      dedupeKey: buildEmbedJobDedupeKey(chunkId, embeddingSetId, chunk.contentHash),
      jobType: 'embed_chunk',
      payload: {
        chunkId,
        dimensionParameter,
        embeddingInputHash,
        embeddingSetId,
        expectedDimension: args.targetDimension,
        fileRecordId: args.fileRecordId,
        modelKey,
        provider,
        sourceContentHash: chunk.contentHash,
      },
      queue: 'embeddings',
    };
  });
}

export async function insertChunksAndEnqueueEmbeddingJobs(
  db: IDatabase,
  args: InsertChunksAndEnqueueEmbeddingJobsArgs
): Promise<void> {
  if (!db.transaction) {
    throw new Error('Atomic chunk/job enqueue requires transactional database support.');
  }
  if (args.chunks.length === 0) {
    return;
  }

  const chunkRepository = new FileChunkRepository({
    query: db.query.bind(db),
    transaction: db.transaction.bind(db),
  });
  await db.transaction(async (tx) => {
    await chunkRepository.insertManyWithTx(tx, [...args.chunks]);
    const queue = new JobQueue(tx);
    await queue.enqueueBatch(await buildEmbeddingJobParams(args));
  });
}
