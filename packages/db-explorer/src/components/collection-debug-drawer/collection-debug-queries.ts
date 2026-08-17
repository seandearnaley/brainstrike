/**
 * One-shot, bounded reads for the collection debug drawer.
 *
 * Deliberately NOT live queries: the drawer is an on-demand debug surface, so
 * every read here is issued when the user asks for it and is bounded by an
 * explicit LIMIT. Nothing here polls or subscribes.
 */

export interface DrawerQueryable {
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
}

/**
 * Narrow the DB context to something queryable. Throws rather than returning
 * an empty result set — an unusable handle is a wiring bug and an empty list
 * would read as "this collection has nothing in it".
 */
export function asDrawerQueryable(database: unknown): DrawerQueryable {
  if (
    typeof database === 'object' &&
    database !== null &&
    typeof (database as { query?: unknown }).query === 'function'
  ) {
    return database as DrawerQueryable;
  }
  throw new Error('Collection details require database query support.');
}

/** Page size for the chunk list. Chunk content is loaded in full, so the page bounds the payload. */
export const DRAWER_CHUNK_PAGE_SIZE = 50;
/** Hard ceiling on the incomplete-embedding list. Truncation is surfaced, never silent. */
export const DRAWER_INCOMPLETE_FILE_LIMIT = 200;

export interface DrawerChunkSummary {
  chunkIndex: number;
  content: string;
  embeddingDimensions: number;
  failed: boolean;
  hasEmbedding: boolean;
  id: string;
  tokenCount: number;
}

/**
 * How the drawer identifies a failed embedding job.
 *
 * `job_queue` carries FIRST-CLASS `chunk_id` / `embedding_set_id` columns
 * (populated by `extractEmbedChunkId` / `extractEmbedEmbeddingSetId` in
 * `packages/db/src/queue/job-queue.ts` whenever `job_type = 'embed_chunk'`),
 * and a partial index `idx_job_queue_embed_set_state` on
 * `(queue, job_type, embedding_set_id, state, updated_at)` to serve exactly
 * this lookup.
 *
 * Do NOT go back to decomposing `dedupe_key`. BST-1214 (#2364) collapsed the
 * two rival key formats into the single producer `buildEmbedJobDedupeKey` in
 * `@brainstrike/indexing-contract`, and that fix deliberately did NOT make the
 * key parseable: `parseDedupeKey` now REJECTS embedding job keys rather than
 * guessing, and every build site documents that positional parsing is not a
 * supported way to recover chunk/set identity. The columns above are. A
 * canonical format is not a stable one — it is free to gain a component, which
 * is exactly how the original `split_part(dedupe_key, ':', 1)` came to report
 * every failed embedding as merely pending.
 *
 * Known bound: terminal rows are pruned after
 * `DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS` (1 hour), so a
 * chunk that failed, was retried, and succeeded can still read as "failed"
 * until its terminal row ages out. The chunk's own `hasEmbedding` is the
 * authority on whether a vector exists; `failed` only reports that the queue
 * recorded a failure recently.
 */
const FAILED_EMBED_JOB_PREDICATE = `
    jq.queue = 'embeddings'
    AND jq.job_type = 'embed_chunk'
    AND jq.state = 'failed'`;

/**
 * Chunks for one file, ordered by chunk index.
 *
 * Chunk ROWS are scoped by file id alone (not by `file_chunks.embedding_set_id`):
 * the file was already resolved within the active collection, and that column
 * is nullable — filtering on it here would silently hide chunks written before
 * a set was assigned. The FAILURE lookup, however, is scoped to the active set,
 * matching the incomplete-files query: a failure recorded against a different
 * embedding set must not mark this chunk.
 *
 * `vector_dims` is projected instead of the vector itself so the heavy
 * embedding payload never crosses the boundary; content IS loaded in full so
 * Copy Content copies the real chunk rather than a truncation.
 */
export const CHUNKS_FOR_FILE_QUERY = `
  SELECT
    fc.id AS "id",
    fc.chunk_index AS "chunkIndex",
    fc.content AS "content",
    COALESCE(fc.token_count, 0) AS "tokenCount",
    (fc.embedding IS NOT NULL) AS "hasEmbedding",
    COALESCE(vector_dims(fc.embedding), 0) AS "embeddingDimensions",
    EXISTS (
      SELECT 1
      FROM job_queue jq
      WHERE ${FAILED_EMBED_JOB_PREDICATE}
        AND jq.chunk_id = fc.id
        AND jq.embedding_set_id = $2
    ) AS "failed"
  FROM file_chunks fc
  WHERE fc.file_record_id = $1
  ORDER BY fc.chunk_index ASC
  LIMIT $3 OFFSET $4
`.trim();

export async function loadChunksForFile(
  database: unknown,
  fileRecordId: string,
  embeddingSetId: string,
  page = 0
): Promise<DrawerChunkSummary[]> {
  const queryable = asDrawerQueryable(database);
  const result = await queryable.query<DrawerChunkSummary>(CHUNKS_FOR_FILE_QUERY, [
    fileRecordId,
    embeddingSetId,
    DRAWER_CHUNK_PAGE_SIZE,
    page * DRAWER_CHUNK_PAGE_SIZE,
  ]);
  return result.rows;
}

export interface DrawerIncompleteFile {
  chunksCount: number;
  chunksProcessed: boolean;
  embeddedChunksCount: number;
  failedChunksCount: number;
  id: string;
  name: string;
  path: string | null;
}

/**
 * Files in the collection that are not fully embedded — the drawer's
 * failed/pending list.
 *
 * "failed" is only knowable from the embedding queue; see
 * FAILED_EMBED_JOB_PREDICATE for why this reads the first-class columns rather
 * than parsing `dedupe_key`. Files with merely-unembedded chunks are reported
 * as pending, so a genuine failure is never flattened into "still working".
 */
export const INCOMPLETE_FILES_QUERY = `
  WITH target AS (SELECT $1::text AS set_id),
  scoped_files AS (
    SELECT fr.id, fr.name, fr.path, fr.chunks_processed_at
    FROM file_records fr
    JOIN target ON fr.embedding_set_id = target.set_id
  ),
  failed_jobs AS (
    SELECT DISTINCT jq.chunk_id AS chunk_id
    FROM job_queue jq, target
    WHERE ${FAILED_EMBED_JOB_PREDICATE}
      AND jq.embedding_set_id = target.set_id
      AND jq.chunk_id IS NOT NULL
  ),
  chunk_rollup AS (
    SELECT
      fc.file_record_id AS file_record_id,
      COUNT(*)::int AS total_chunks,
      COUNT(*) FILTER (WHERE fc.embedding IS NULL)::int AS unembedded_chunks,
      COUNT(*) FILTER (WHERE fj.chunk_id IS NOT NULL)::int AS failed_chunks
    FROM file_chunks fc
    JOIN scoped_files sf ON sf.id = fc.file_record_id
    LEFT JOIN failed_jobs fj ON fj.chunk_id = fc.id
    GROUP BY fc.file_record_id
  )
  SELECT
    sf.id AS "id",
    sf.name AS "name",
    sf.path AS "path",
    COALESCE(cr.total_chunks, 0) AS "chunksCount",
    (COALESCE(cr.total_chunks, 0) - COALESCE(cr.unembedded_chunks, 0)) AS "embeddedChunksCount",
    COALESCE(cr.failed_chunks, 0) AS "failedChunksCount",
    (sf.chunks_processed_at IS NOT NULL) AS "chunksProcessed"
  FROM scoped_files sf
  LEFT JOIN chunk_rollup cr ON cr.file_record_id = sf.id
  WHERE COALESCE(cr.unembedded_chunks, 0) > 0
     OR COALESCE(cr.failed_chunks, 0) > 0
     OR sf.chunks_processed_at IS NULL
  ORDER BY
    COALESCE(cr.failed_chunks, 0) DESC,
    COALESCE(cr.unembedded_chunks, 0) DESC,
    sf.name ASC
  LIMIT $2
`.trim();

export async function loadIncompleteFiles(
  database: unknown,
  embeddingSetId: string
): Promise<DrawerIncompleteFile[]> {
  const queryable = asDrawerQueryable(database);
  const result = await queryable.query<DrawerIncompleteFile>(INCOMPLETE_FILES_QUERY, [
    embeddingSetId,
    DRAWER_INCOMPLETE_FILE_LIMIT,
  ]);
  return result.rows;
}
