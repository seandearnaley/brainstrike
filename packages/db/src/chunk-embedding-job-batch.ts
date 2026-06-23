import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import type { BrainstrikeDbExecutionClient } from './architecture/brainstrike-db-client-contract.js';
import type { FileChunkInsert } from './models/file-chunk.js';
import {
  insertChunksAndEnqueueEmbeddingJobsImpl,
  insertTursoChunksAndEnqueueEmbeddingJobsImpl,
} from './queue/chunk-embedding-job-batch-impl.js';
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

export async function insertChunksAndEnqueueEmbeddingJobs(
  db: IDatabase,
  args: InsertChunksAndEnqueueEmbeddingJobsArgs
): Promise<void> {
  await insertChunksAndEnqueueEmbeddingJobsImpl(db, args);
}

export async function insertTursoChunksAndEnqueueEmbeddingJobs(
  db: BrainstrikeDbExecutionClient,
  args: InsertChunksAndEnqueueEmbeddingJobsArgs
): Promise<void> {
  await insertTursoChunksAndEnqueueEmbeddingJobsImpl(db, args);
}
