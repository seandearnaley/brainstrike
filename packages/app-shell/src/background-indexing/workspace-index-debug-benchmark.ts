import { type IDatabase, JobQueue } from '@brainstrike/db';

export type WorkspaceIndexStageBenchmarkMode =
  | 'chunking-ceiling'
  | 'db-completion-ceiling'
  | 'embedding-ceiling'
  | 'import-ceiling'
  | 'integrated';

export interface WorkspaceIndexStageBenchmarkRequest {
  chunkCount?: number;
  dimensions?: number;
  mode: WorkspaceIndexStageBenchmarkMode;
}

export interface WorkspaceIndexStageBenchmarkResult {
  chunkCount: number;
  chunksPerSecond: number;
  completedAt: string;
  completedChunkCount: number;
  dimensions: number;
  elapsedMs: number;
  mode: WorkspaceIndexStageBenchmarkMode;
  startedAt: string;
}

interface WorkspaceIndexStageBenchmarkArgs {
  db?: IDatabase | null;
  electronRunTransaction?: WorkspaceIndexElectronRunTransaction | undefined;
  electronTransactionOptions?: unknown;
  request: WorkspaceIndexStageBenchmarkRequest;
  timing?: {
    nowIso?: () => string;
    nowMs?: () => number;
  };
}

type CompleteEmbeddingChunkInput = Parameters<JobQueue['completeEmbeddingChunkBatch']>[0][number];
interface WorkspaceIndexElectronTransactionStatement {
  params?: unknown[];
  sql: string;
}
type WorkspaceIndexElectronRunTransaction = (
  statements: WorkspaceIndexElectronTransactionStatement[],
  resultIndex: number,
  options?: unknown
) => Promise<{ rows?: unknown[] }>;
interface DbCompletionBenchmarkIds {
  chunkIds: string[];
  embeddingSetId: string;
  fileRecordId: string;
  jobIds: string[];
  leaseTokens: string[];
  rootId: string;
}

const DEFAULT_DB_COMPLETION_CHUNK_COUNT = 512;
const DEFAULT_DB_COMPLETION_DIMENSIONS = 384;
const MAX_DB_COMPLETION_CHUNK_COUNT = 10_000;
const MAX_DB_COMPLETION_DIMENSIONS = 4096;
const SYNTHETIC_ID_PREFIX = 'workspace-index-stage-db-completion-ceiling';

function assertPositiveInteger(value: number, label: string, max: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
}

function createEmbedding(dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_value, index) => (index + 1) / 1000);
}

function createDbCompletionBenchmarkIds(
  chunkCount: number,
  startedAt: string
): DbCompletionBenchmarkIds {
  const syntheticRunId = `${SYNTHETIC_ID_PREFIX}-${startedAt.replace(/[^0-9A-Za-z]/g, '')}`;
  return {
    chunkIds: Array.from(
      { length: chunkCount },
      (_value, index) => `${syntheticRunId}-chunk-${index}`
    ),
    embeddingSetId: `${syntheticRunId}-embedding-set`,
    fileRecordId: `${syntheticRunId}-file`,
    jobIds: Array.from({ length: chunkCount }, (_value, index) => `${syntheticRunId}-job-${index}`),
    leaseTokens: Array.from(
      { length: chunkCount },
      (_value, index) => `${syntheticRunId}-lease-${index}`
    ),
    rootId: `${syntheticRunId}-root`,
  };
}

function buildPlaceholders(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_row, rowIndex) => {
    const offset = rowIndex * columnCount;
    const rowPlaceholders = Array.from(
      { length: columnCount },
      (_column, columnIndex) => `$${offset + columnIndex + 1}`
    ).join(', ');
    return `(${rowPlaceholders})`;
  }).join(', ');
}

async function seedDbCompletionBenchmarkRows(
  tx: IDatabase,
  ids: DbCompletionBenchmarkIds,
  dimensions: number,
  now: string
): Promise<void> {
  await tx.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at, name, description, category, allow_duplicates)
     VALUES ($1, $2, $3, $4, 'cosine', $5, $6, $7, $8, false)
     ON CONFLICT (id) DO NOTHING`,
    [
      ids.embeddingSetId,
      'debug:db-completion-ceiling',
      'debug-db-completion-ceiling',
      dimensions,
      now,
      'Workspace Index DB completion benchmark',
      'Synthetic rows for measuring JobQueue.completeEmbeddingChunkBatch.',
      'debug',
    ]
  );

  await tx.query(
    `INSERT INTO roots (id, kind, display_name, path, status, created_at, last_verified_at)
     VALUES ($1, 'path', $2, $3, 'live', $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [
      ids.rootId,
      'Workspace Index DB completion benchmark',
      `/__brainstrike_debug__/${ids.rootId}`,
      now,
    ]
  );

  await tx.query(
    `INSERT INTO file_records (
       id, name, path, root_id, size, mtime_ms, created_at, updated_at, content,
       content_hash, token_count, processed_at, embedding_set_id, chunks_processed_at,
       chunks_count, chunking_strategy
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $7, $11, $7, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [
      ids.fileRecordId,
      'db-completion-ceiling.txt',
      'db-completion-ceiling.txt',
      ids.rootId,
      128,
      Date.parse(now),
      now,
      'Workspace Index DB completion benchmark',
      `${ids.fileRecordId}:content`,
      ids.chunkIds.length,
      ids.embeddingSetId,
      ids.chunkIds.length,
      'sentence',
    ]
  );

  const chunkColumnCount = 18;
  const chunkValues = ids.chunkIds.flatMap((chunkId, index) => [
    chunkId,
    ids.fileRecordId,
    index,
    `Synthetic benchmark chunk ${index}`,
    `${chunkId}:content`,
    8,
    'text',
    32,
    index + 1,
    index + 1,
    index * 32,
    index * 32 + 31,
    null,
    ids.embeddingSetId,
    null,
    null,
    now,
    now,
  ]);
  await tx.query(
    `INSERT INTO file_chunks (
       id, file_record_id, chunk_index, content, content_hash, token_count,
       chunk_type, chunk_size, start_line, end_line, start_offset, end_offset,
       embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at
     )
     VALUES ${buildPlaceholders(ids.chunkIds.length, chunkColumnCount)}`,
    chunkValues
  );

  const jobColumnCount = 16;
  const jobValues = ids.jobIds.flatMap((jobId, index) => [
    jobId,
    'embedding',
    'embed_chunk',
    JSON.stringify({ chunkId: ids.chunkIds[index], embeddingSetId: ids.embeddingSetId }),
    'running',
    now,
    1,
    5,
    0,
    ids.leaseTokens[index],
    now,
    'workspace-index-stage-benchmark',
    `${SYNTHETIC_ID_PREFIX}:dedupe:${jobId}`,
    ids.embeddingSetId,
    now,
    now,
  ]);
  await tx.query(
    `INSERT INTO job_queue (
       id, queue, job_type, payload, state, run_at, attempts, max_attempts,
       backoff_ms, lease_token, leased_until, worker_id, dedupe_key,
       embedding_set_id, created_at, updated_at
     )
     VALUES ${buildPlaceholders(ids.jobIds.length, jobColumnCount)}`,
    jobValues
  );
}

async function cleanupDbCompletionBenchmarkRows(
  tx: IDatabase,
  ids: Pick<DbCompletionBenchmarkIds, 'embeddingSetId' | 'jobIds' | 'rootId'>
): Promise<void> {
  await tx.query('DELETE FROM job_queue WHERE id = ANY($1::text[])', [ids.jobIds]);
  await tx.query('DELETE FROM roots WHERE id = $1', [ids.rootId]);
  await tx.query('DELETE FROM embedding_sets WHERE id = $1', [ids.embeddingSetId]);
}

function createDbCompletionBenchmarkStatements(
  ids: DbCompletionBenchmarkIds,
  dimensions: number,
  embedding: number[],
  now: string
): {
  completionResultIndex: number;
  statements: WorkspaceIndexElectronTransactionStatement[];
} {
  const chunkColumnCount = 18;
  const chunkValues = ids.chunkIds.flatMap((chunkId, index) => [
    chunkId,
    ids.fileRecordId,
    index,
    `Synthetic benchmark chunk ${index}`,
    `${chunkId}:content`,
    8,
    'text',
    32,
    index + 1,
    index + 1,
    index * 32,
    index * 32 + 31,
    null,
    ids.embeddingSetId,
    null,
    null,
    now,
    now,
  ]);
  const jobColumnCount = 16;
  const jobValues = ids.jobIds.flatMap((jobId, index) => [
    jobId,
    'embedding',
    'embed_chunk',
    JSON.stringify({ chunkId: ids.chunkIds[index], embeddingSetId: ids.embeddingSetId }),
    'running',
    now,
    1,
    5,
    0,
    ids.leaseTokens[index],
    now,
    'workspace-index-stage-benchmark',
    `${SYNTHETIC_ID_PREFIX}:dedupe:${jobId}`,
    ids.embeddingSetId,
    now,
    now,
  ]);
  const embeddingStrings = ids.chunkIds.map(() => `[${embedding.join(',')}]`);
  const embeddingHashes = ids.chunkIds.map((chunkId) => `${chunkId}:embedding`);
  const completionResultIndex = 5;
  return {
    completionResultIndex,
    statements: [
      {
        sql: `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at, name, description, category, allow_duplicates)
              VALUES ($1, $2, $3, $4, 'cosine', $5, $6, $7, $8, false)
              ON CONFLICT (id) DO NOTHING`,
        params: [
          ids.embeddingSetId,
          'debug:db-completion-ceiling',
          'debug-db-completion-ceiling',
          dimensions,
          now,
          'Workspace Index DB completion benchmark',
          'Synthetic rows for measuring DB-host embedding completion.',
          'debug',
        ],
      },
      {
        sql: `INSERT INTO roots (id, kind, display_name, path, status, created_at, last_verified_at)
              VALUES ($1, 'path', $2, $3, 'live', $4, $4)
              ON CONFLICT (id) DO NOTHING`,
        params: [
          ids.rootId,
          'Workspace Index DB completion benchmark',
          `/__brainstrike_debug__/${ids.rootId}`,
          now,
        ],
      },
      {
        sql: `INSERT INTO file_records (
                id, name, path, root_id, size, mtime_ms, created_at, updated_at, content,
                content_hash, token_count, processed_at, embedding_set_id, chunks_processed_at,
                chunks_count, chunking_strategy
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $7, $11, $7, $12, $13)
              ON CONFLICT (id) DO NOTHING`,
        params: [
          ids.fileRecordId,
          'db-completion-ceiling.txt',
          'db-completion-ceiling.txt',
          ids.rootId,
          128,
          Date.parse(now),
          now,
          'Workspace Index DB completion benchmark',
          `${ids.fileRecordId}:content`,
          ids.chunkIds.length,
          ids.embeddingSetId,
          ids.chunkIds.length,
          'sentence',
        ],
      },
      {
        sql: `INSERT INTO file_chunks (
                id, file_record_id, chunk_index, content, content_hash, token_count,
                chunk_type, chunk_size, start_line, end_line, start_offset, end_offset,
                embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at
              )
              VALUES ${buildPlaceholders(ids.chunkIds.length, chunkColumnCount)}`,
        params: chunkValues,
      },
      {
        sql: `INSERT INTO job_queue (
                id, queue, job_type, payload, state, run_at, attempts, max_attempts,
                backoff_ms, lease_token, leased_until, worker_id, dedupe_key,
                embedding_set_id, created_at, updated_at
              )
              VALUES ${buildPlaceholders(ids.jobIds.length, jobColumnCount)}`,
        params: jobValues,
      },
      {
        sql: `WITH input AS (
                SELECT *
                  FROM unnest(
                    $2::text[],
                    $3::text[],
                    $4::text[],
                    $5::text[],
                    $6::text[],
                    $7::text[]
                  ) AS t(id, lease_token, chunk_id, embedding, embedding_set_id, embedding_hash)
              ),
              owned_jobs AS (
                SELECT
                  j.id AS job_id,
                  i.chunk_id,
                  i.embedding,
                  i.embedding_set_id,
                  i.embedding_hash
                FROM job_queue AS j
                JOIN input AS i
                 ON j.id = i.id
                 AND j.lease_token = i.lease_token
                WHERE j.state = 'running'
              ),
              chunk_updates AS (
                SELECT DISTINCT ON (chunk_id)
                  chunk_id,
                  embedding,
                  embedding_set_id,
                  embedding_hash
                FROM owned_jobs
                ORDER BY chunk_id, job_id
              ),
              updated_chunks AS (
                UPDATE file_chunks AS fc
                   SET embedding = u.embedding::vector,
                       embedding_set_id = u.embedding_set_id,
                       embedding_updated_at = $1,
                       embedding_hash = u.embedding_hash,
                       updated_at = $1
                  FROM chunk_updates AS u
                 WHERE fc.id = u.chunk_id
                 RETURNING fc.id AS chunk_id
              ),
              completed_jobs AS (
                UPDATE job_queue AS j
                   SET state = 'succeeded',
                       chunk_id = COALESCE(j.chunk_id, o.chunk_id::text),
                       embedding_set_id = COALESCE(j.embedding_set_id, o.embedding_set_id),
                       leased_until = NULL,
                       updated_at = $1
                  FROM owned_jobs AS o
                  JOIN updated_chunks AS u ON u.chunk_id = o.chunk_id
                 WHERE j.id = o.job_id
                 RETURNING j.*
              )
              SELECT * FROM completed_jobs`,
        params: [
          now,
          ids.jobIds,
          ids.leaseTokens,
          ids.chunkIds,
          embeddingStrings,
          ids.chunkIds.map(() => ids.embeddingSetId),
          embeddingHashes,
        ],
      },
      {
        sql: 'DELETE FROM job_queue WHERE id = ANY($1::text[])',
        params: [ids.jobIds],
      },
      {
        sql: 'DELETE FROM roots WHERE id = $1',
        params: [ids.rootId],
      },
      {
        sql: 'DELETE FROM embedding_sets WHERE id = $1',
        params: [ids.embeddingSetId],
      },
    ],
  };
}

async function runDbCompletionCeilingBenchmarkOverElectronTransaction({
  electronRunTransaction,
  electronTransactionOptions,
  request,
  timing,
}: WorkspaceIndexStageBenchmarkArgs): Promise<WorkspaceIndexStageBenchmarkResult> {
  if (!electronRunTransaction) {
    throw new Error(
      "Workspace Index benchmark mode 'db-completion-ceiling' requires transactional database support."
    );
  }
  const chunkCount = request.chunkCount ?? DEFAULT_DB_COMPLETION_CHUNK_COUNT;
  const dimensions = request.dimensions ?? DEFAULT_DB_COMPLETION_DIMENSIONS;
  assertPositiveInteger(chunkCount, 'chunkCount', MAX_DB_COMPLETION_CHUNK_COUNT);
  assertPositiveInteger(dimensions, 'dimensions', MAX_DB_COMPLETION_DIMENSIONS);
  const nowIso = timing?.nowIso ?? (() => new Date().toISOString());
  const nowMs =
    timing?.nowMs ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
  const startedAt = nowIso();
  const ids = createDbCompletionBenchmarkIds(chunkCount, startedAt);
  const embedding = createEmbedding(dimensions);
  const { completionResultIndex, statements } = createDbCompletionBenchmarkStatements(
    ids,
    dimensions,
    embedding,
    startedAt
  );
  const startedMs = nowMs();
  const completed = await electronRunTransaction(
    statements,
    completionResultIndex,
    electronTransactionOptions
  );
  const elapsedMs = Math.max(0, nowMs() - startedMs);
  const completedChunkCount = Array.isArray(completed.rows) ? completed.rows.length : 0;
  return {
    chunkCount,
    chunksPerSecond: elapsedMs > 0 ? (completedChunkCount / elapsedMs) * 1000 : completedChunkCount,
    completedAt: nowIso(),
    completedChunkCount,
    dimensions,
    elapsedMs,
    mode: 'db-completion-ceiling',
    startedAt,
  };
}

async function runDbCompletionCeilingBenchmark({
  db,
  request,
  timing,
}: WorkspaceIndexStageBenchmarkArgs): Promise<WorkspaceIndexStageBenchmarkResult> {
  if (typeof db?.transaction !== 'function') {
    throw new Error(
      "Workspace Index benchmark mode 'db-completion-ceiling' requires transactional database support."
    );
  }

  const chunkCount = request.chunkCount ?? DEFAULT_DB_COMPLETION_CHUNK_COUNT;
  const dimensions = request.dimensions ?? DEFAULT_DB_COMPLETION_DIMENSIONS;
  assertPositiveInteger(chunkCount, 'chunkCount', MAX_DB_COMPLETION_CHUNK_COUNT);
  assertPositiveInteger(dimensions, 'dimensions', MAX_DB_COMPLETION_DIMENSIONS);

  const nowIso = timing?.nowIso ?? (() => new Date().toISOString());
  const nowMs =
    timing?.nowMs ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
  const startedAt = nowIso();
  const ids = createDbCompletionBenchmarkIds(chunkCount, startedAt);
  const embedding = createEmbedding(dimensions);
  let elapsedMs = 0;
  let completedChunkCount = 0;

  await db.transaction(async (tx) => {
    await seedDbCompletionBenchmarkRows(tx, ids, dimensions, startedAt);
    const jobQueue = new JobQueue(tx);
    const jobs: CompleteEmbeddingChunkInput[] = ids.jobIds.map((jobId, index) => {
      const chunkId = ids.chunkIds[index];
      const leaseToken = ids.leaseTokens[index];
      if (!(chunkId && leaseToken)) {
        throw new Error('Workspace Index DB completion benchmark generated inconsistent ids.');
      }
      return {
        chunkId,
        embedding,
        embeddingHash: `${chunkId}:embedding`,
        embeddingSetId: ids.embeddingSetId,
        id: jobId,
        leaseToken,
      };
    });

    const startedMs = nowMs();
    try {
      const completedJobs = await jobQueue.completeEmbeddingChunkBatch(jobs);
      elapsedMs = Math.max(0, nowMs() - startedMs);
      completedChunkCount = completedJobs.length;
    } finally {
      await cleanupDbCompletionBenchmarkRows(tx, ids);
    }
  });

  return {
    chunkCount,
    chunksPerSecond: elapsedMs > 0 ? (completedChunkCount / elapsedMs) * 1000 : completedChunkCount,
    completedAt: nowIso(),
    completedChunkCount,
    dimensions,
    elapsedMs,
    mode: 'db-completion-ceiling',
    startedAt,
  };
}

export async function runWorkspaceIndexStageBenchmark(
  args: WorkspaceIndexStageBenchmarkArgs
): Promise<WorkspaceIndexStageBenchmarkResult> {
  if (args.request.mode === 'db-completion-ceiling') {
    if (typeof args.db?.transaction === 'function') {
      return await runDbCompletionCeilingBenchmark(args);
    }
    return await runDbCompletionCeilingBenchmarkOverElectronTransaction(args);
  }
  throw new Error(`Workspace Index benchmark mode '${args.request.mode}' is not implemented yet.`);
}
