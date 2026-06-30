import type { Job } from '@brainstrike/db';
import type { EmbedChunkRow } from './embedding-worker-db-io';
import type { EmbedChunkPayload, EmbeddingJobModel } from './embedding-worker-job-payload';
import { assertEmbedChunkJob } from './embedding-worker-job-payload';

// biome-ignore lint/style/useNamingConvention: lease_token is a database field name.
export type ClaimedEmbeddingJob = Job & { lease_token: string };

export interface LoadedChunkItem {
  chunk: EmbedChunkRow;
  expectedHash: string;
  job: ClaimedEmbeddingJob;
  payload: EmbedChunkPayload;
}

export interface LoadAndFilterChunksOptions {
  failOrphanJobs: (jobs: Array<{ id: string; leaseToken: string }>, error: string) => Promise<void>;
  hashExpectedEmbedding: (input: string) => Promise<string>;
  loadChunksByIds: (ids: readonly string[]) => Promise<EmbedChunkRow[]>;
  logWarn: (message: string, meta?: unknown) => void;
}

function isEmbeddingUpToDate(chunk: EmbedChunkRow, expectedHash: string): boolean {
  return Boolean(chunk.embeddingHash && chunk.embeddingHash === expectedHash);
}

export async function loadAndFilterChunks(
  jobs: ClaimedEmbeddingJob[],
  jobModel: EmbeddingJobModel,
  options: LoadAndFilterChunksOptions
): Promise<{
  completed: LoadedChunkItem[];
  orphanCount: number;
  toProcess: LoadedChunkItem[];
}> {
  const chunkIds = jobs.map((job) => assertEmbedChunkJob(job).chunkId);
  const loadedChunks = await options.loadChunksByIds(chunkIds);
  const chunkMap = new Map(loadedChunks.map((chunk) => [chunk.id, chunk]));

  const found: Array<{
    chunk: NonNullable<ReturnType<typeof chunkMap.get>>;
    job: ClaimedEmbeddingJob;
    payload: ReturnType<typeof assertEmbedChunkJob>;
  }> = [];
  const orphans: Array<{ chunkId: string; job: ClaimedEmbeddingJob }> = [];

  for (const job of jobs) {
    const payload = assertEmbedChunkJob(job);
    const chunk = chunkMap.get(payload.chunkId);
    if (chunk) {
      found.push({ job, chunk, payload });
    } else {
      orphans.push({ job, chunkId: payload.chunkId });
    }
  }

  if (orphans.length > 0) {
    options.logWarn('Embedding jobs reference deleted chunks; failing as terminal', {
      orphanCount: orphans.length,
      sampleChunkIds: orphans.slice(0, 3).map((orphan) => orphan.chunkId),
    });
    await options.failOrphanJobs(
      orphans.map((orphan) => ({ id: orphan.job.id, leaseToken: orphan.job.lease_token })),
      'Chunk no longer exists (likely re-chunked or deleted)'
    );
  }

  const toProcess: LoadedChunkItem[] = [];
  const completed: LoadedChunkItem[] = [];
  for (const item of found) {
    const expectedHash = await options.hashExpectedEmbedding(
      `${item.chunk.contentHash}:${jobModel.compositeKey}`
    );
    const tagged = { ...item, expectedHash };
    if (isEmbeddingUpToDate(item.chunk, expectedHash)) {
      completed.push(tagged);
    } else {
      toProcess.push(tagged);
    }
  }

  return { toProcess, completed, orphanCount: orphans.length };
}
