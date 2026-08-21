import type { IDatabase, Job } from '@brainstrike/db';
import { type loadChunk, loadChunksBatch } from './embedding-worker-db-io.js';
import type { EmbedChunkPayload } from './embedding-worker-job-payload.js';
import { assertEmbedChunkJob } from './embedding-worker-job-payload.js';

// biome-ignore lint/style/useNamingConvention: lease_token is a database field name.
export type ClaimedEmbeddingJob = Job & { lease_token: string };

export interface LoadedChunkItem {
  chunk: NonNullable<Awaited<ReturnType<typeof loadChunk>>>;
  expectedHash: string;
  job: ClaimedEmbeddingJob;
  payload: EmbedChunkPayload;
}

export interface LoadAndFilterChunksOptions {
  db: IDatabase;
  failTerminalJobs: (
    jobs: Array<{ id: string; leaseToken: string }>,
    error: string
  ) => Promise<void>;
  fileChunkIdType: string;
  logWarn: (message: string, meta?: unknown) => void;
}

function isEmbeddingUpToDate(
  chunk: NonNullable<Awaited<ReturnType<typeof loadChunk>>>,
  expectedHash: string
): boolean {
  return Boolean(chunk.embeddingHash && chunk.embeddingHash === expectedHash);
}

export async function loadAndFilterChunks(
  jobs: ClaimedEmbeddingJob[],
  options: LoadAndFilterChunksOptions
): Promise<{
  completed: LoadedChunkItem[];
  orphanCount: number;
  staleCount: number;
  toProcess: LoadedChunkItem[];
}> {
  const chunkIds = jobs.map((job) => assertEmbedChunkJob(job).chunkId);
  const loadedChunks = await loadChunksBatch(options.db, chunkIds, options.fileChunkIdType);
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
      found.push({ chunk, job, payload });
    } else {
      orphans.push({ chunkId: payload.chunkId, job });
    }
  }

  if (orphans.length > 0) {
    options.logWarn('Embedding jobs reference deleted chunks; failing as terminal', {
      orphanCount: orphans.length,
      sampleChunkIds: orphans.slice(0, 3).map((orphan) => orphan.chunkId),
    });
    await options.failTerminalJobs(
      orphans.map((orphan) => ({ id: orphan.job.id, leaseToken: orphan.job.lease_token })),
      'Chunk no longer exists (likely re-chunked or deleted)'
    );
  }

  const current: typeof found = [];
  const stale: typeof found = [];
  for (const item of found) {
    if (item.payload.sourceContentHash === item.chunk.contentHash) {
      current.push(item);
    } else {
      stale.push(item);
    }
  }
  if (stale.length > 0) {
    options.logWarn('Embedding jobs reference changed chunks; failing as terminal', {
      sampleChunkIds: stale.slice(0, 3).map((item) => item.payload.chunkId),
      staleCount: stale.length,
    });
    await options.failTerminalJobs(
      stale.map((item) => ({ id: item.job.id, leaseToken: item.job.lease_token })),
      'Chunk content changed after embedding job was enqueued'
    );
  }

  const toProcess: LoadedChunkItem[] = [];
  const completed: LoadedChunkItem[] = [];
  for (const item of current) {
    const tagged = { ...item, expectedHash: item.payload.embeddingInputHash };
    if (isEmbeddingUpToDate(item.chunk, tagged.expectedHash)) {
      completed.push(tagged);
    } else {
      toProcess.push(tagged);
    }
  }

  return { completed, orphanCount: orphans.length, staleCount: stale.length, toProcess };
}
