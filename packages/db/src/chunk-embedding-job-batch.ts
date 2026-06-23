import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import { generateUUID } from '@brainstrike/utils';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from './architecture/brainstrike-db-client-contract.js';
import type { FileChunkInsert } from './models/file-chunk.js';
import { type EnqueueParams, JobQueue } from './queue/job-queue.js';
import { FileChunkRepository } from './repositories/file-chunk-repository.js';
import type { IDatabase } from './repositories/interfaces.js';
import { TursoFileChunkRepository } from './repositories/turso-file-chunk-repository.js';

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

interface TursoActiveJobRow {
  readonly id: string;
  readonly run_at: string;
}

const TURSO_DEFAULT_MAX_ATTEMPTS = 5;

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

export async function insertTursoChunksAndEnqueueEmbeddingJobs(
  db: BrainstrikeDbExecutionClient,
  args: InsertChunksAndEnqueueEmbeddingJobsArgs
): Promise<void> {
  if (args.chunks.length === 0) {
    return;
  }

  const chunkRepository = new TursoFileChunkRepository(db);
  await db.transaction(async (tx) => {
    await chunkRepository.insertManyWithTx(tx, [...args.chunks]);
    await enqueueTursoEmbeddingJobs(tx, buildEmbeddingJobParams(args));
  });
}

async function enqueueTursoEmbeddingJobs(
  tx: BrainstrikeDbTransactionClient,
  params: EnqueueParams[]
): Promise<void> {
  const now = new Date().toISOString();
  const processedParams = processTursoBatchParams(params, now);

  for (const param of processedParams) {
    const runAt = param.runAt ?? now;
    const dedupeKey = param.dedupeKey ?? null;
    const chunkId = extractTursoEmbedChunkId(param);
    const embeddingSetId = extractTursoEmbedEmbeddingSetId(param);
    const payload = JSON.stringify(param.payload);
    if (payload === undefined) {
      throw new Error('Cannot enqueue Turso embedding job with an undefined payload.');
    }

    if (dedupeKey) {
      const existing = await tx.query<TursoActiveJobRow>(
        `SELECT id, run_at
           FROM job_queue
          WHERE dedupe_key = ?
            AND state IN ('queued', 'running')
          ORDER BY created_at ASC
          LIMIT 1`,
        [dedupeKey]
      );
      const activeJob = existing.rows[0];
      if (activeJob) {
        await tx.exec(
          `UPDATE job_queue
              SET run_at = ?,
                  chunk_id = COALESCE(chunk_id, ?),
                  embedding_set_id = COALESCE(embedding_set_id, ?),
                  updated_at = ?
            WHERE id = ?`,
          [earlierIso(activeJob.run_at, runAt), chunkId, embeddingSetId, now, activeJob.id]
        );
        continue;
      }
    }

    await tx.exec(
      `INSERT INTO job_queue (
         id,
         queue,
         job_type,
         payload,
         chunk_id,
         embedding_set_id,
         state,
         run_at,
         attempts,
         max_attempts,
         backoff_ms,
         lease_token,
         leased_until,
         worker_id,
         dedupe_key,
         error,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, 0, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      [
        generateUUID(),
        param.queue,
        param.jobType,
        payload,
        chunkId,
        embeddingSetId,
        runAt,
        param.maxAttempts ?? TURSO_DEFAULT_MAX_ATTEMPTS,
        dedupeKey,
        now,
        now,
      ]
    );
  }
}

function processTursoBatchParams(params: EnqueueParams[], now: string): EnqueueParams[] {
  const processedParams: EnqueueParams[] = [];
  const seenDedupeKeys = new Map<string, EnqueueParams>();

  for (const param of params) {
    const withRunAt = { ...param, runAt: param.runAt ?? now };
    if (!param.dedupeKey) {
      processedParams.push(withRunAt);
      continue;
    }

    const existing = seenDedupeKeys.get(param.dedupeKey);
    if (!existing) {
      seenDedupeKeys.set(param.dedupeKey, withRunAt);
      processedParams.push(withRunAt);
      continue;
    }

    existing.runAt = earlierIso(existing.runAt ?? now, withRunAt.runAt);
  }

  return processedParams;
}

function earlierIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function extractTursoEmbedChunkId(param: EnqueueParams): string | null {
  if (param.jobType !== 'embed_chunk' || !(param.payload && typeof param.payload === 'object')) {
    return null;
  }
  const chunkId = (param.payload as { chunkId?: unknown }).chunkId;
  return typeof chunkId === 'string' && chunkId.length > 0 ? chunkId : null;
}

function extractTursoEmbedEmbeddingSetId(param: EnqueueParams): string | null {
  if (param.jobType !== 'embed_chunk' || !(param.payload && typeof param.payload === 'object')) {
    return null;
  }
  const embeddingSetId = (param.payload as { embeddingSetId?: unknown }).embeddingSetId;
  return typeof embeddingSetId === 'string' && embeddingSetId.length > 0 ? embeddingSetId : null;
}
