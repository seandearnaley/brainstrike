import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
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

function buildDedupeKey(
  chunkId: string,
  embeddingSetId: string | null,
  contentHash: string
): string {
  return `${chunkId}:${embeddingSetId ?? 'none'}:${contentHash}`;
}

function buildEmbeddingJobParams(args: InsertChunksAndEnqueueEmbeddingJobsArgs): EnqueueParams[] {
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

  return args.chunks.map((chunk) => {
    const chunkId = requireNonEmptyString(
      chunk.id,
      'Cannot enqueue embedding job for chunk without id.'
    );
    if (chunk.fileRecordId !== args.fileRecordId) {
      throw new Error(
        `Cannot enqueue embedding job for chunk '${chunkId}' with mismatched file record id.`
      );
    }
    return {
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: {
        chunkId,
        fileRecordId: args.fileRecordId,
        embeddingSetId,
        expectedDimension: args.targetDimension,
        modelKey,
        provider,
        dimensionParameter,
      },
      dedupeKey: buildDedupeKey(chunkId, embeddingSetId, chunk.contentHash),
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

  await db.transaction(async (tx) => {
    const chunkRepository = new FileChunkRepository(tx as never);
    await chunkRepository.insertManyWithTx(tx as never, [...args.chunks]);
    const queue = new JobQueue(tx);
    await queue.enqueueBatch(buildEmbeddingJobParams(args));
  });
}
