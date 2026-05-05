import { type DatabaseWorkOptions, getDatabaseWorkScheduler } from '../database-work-scheduler.js';

export interface CollectionIndexingStats {
  readonly chunkCount: number;
  readonly dirty: boolean;
  readonly embeddedChunkCount: number;
  readonly embeddingSetId: string;
  readonly fileCount: number;
  readonly lastRefreshedAt: string;
  readonly pendingChunkCount: number;
}

interface CollectionIndexingStatsRow {
  readonly chunkCount: number | string;
  readonly dirty: boolean | string;
  readonly embeddedChunkCount: number | string;
  readonly embeddingSetId: string;
  readonly fileCount: number | string;
  readonly lastRefreshedAt: string;
  readonly pendingChunkCount: number | string;
}

interface CollectionStatsDatabase {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

function toNumber(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid collection indexing stats count: ${String(value)}`);
  }
  return parsed;
}

function toBoolean(value: boolean | string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 't') {
    return true;
  }
  if (value === 'false' || value === 'f') {
    return false;
  }
  throw new Error(`Invalid collection indexing stats dirty flag: ${value}`);
}

function mapStatsRow(row: CollectionIndexingStatsRow): CollectionIndexingStats {
  return {
    embeddingSetId: row.embeddingSetId,
    fileCount: toNumber(row.fileCount),
    chunkCount: toNumber(row.chunkCount),
    embeddedChunkCount: toNumber(row.embeddedChunkCount),
    pendingChunkCount: toNumber(row.pendingChunkCount),
    dirty: toBoolean(row.dirty),
    lastRefreshedAt: row.lastRefreshedAt,
  };
}

async function queryStatsDatabase(
  db: CollectionStatsDatabase,
  sql: string,
  params?: unknown[],
  options?: DatabaseWorkOptions
): Promise<{ rows: unknown[] }> {
  if (!(options && getDatabaseWorkScheduler(db))) {
    return await db.query(sql, params);
  }
  const scheduledQuery = db.query as (
    querySql: string,
    queryParams: unknown[] | undefined,
    queryOptions: DatabaseWorkOptions
  ) => Promise<{ rows: unknown[] }>;
  return await scheduledQuery(sql, params, options);
}

const STATS_SELECT = `
  SELECT
    embedding_set_id AS "embeddingSetId",
    file_count AS "fileCount",
    chunk_count AS "chunkCount",
    embedded_chunk_count AS "embeddedChunkCount",
    pending_chunk_count AS "pendingChunkCount",
    dirty,
    last_refreshed_at AS "lastRefreshedAt"
  FROM collection_indexing_stats
`.trim();

export async function getCollectionIndexingStats(
  db: CollectionStatsDatabase,
  embeddingSetId: string,
  options?: DatabaseWorkOptions
): Promise<CollectionIndexingStats | null> {
  const result = await queryStatsDatabase(
    db,
    `${STATS_SELECT} WHERE embedding_set_id = $1`,
    [embeddingSetId],
    options
  );
  const row = result.rows[0] as CollectionIndexingStatsRow | undefined;
  return row ? mapStatsRow(row) : null;
}

export async function markCollectionIndexingStatsDirty(
  db: CollectionStatsDatabase,
  embeddingSetIds: readonly string[],
  options?: DatabaseWorkOptions
): Promise<void> {
  if (embeddingSetIds.length === 0) {
    return;
  }
  await queryStatsDatabase(
    db,
    `UPDATE collection_indexing_stats
        SET dirty = TRUE
      WHERE embedding_set_id = ANY($1::text[])`,
    [[...new Set(embeddingSetIds)]],
    options
  );
}

export async function refreshCollectionIndexingStats(
  db: CollectionStatsDatabase,
  embeddingSetIds: readonly string[],
  options?: DatabaseWorkOptions
): Promise<CollectionIndexingStats[]> {
  const uniqueIds = [...new Set(embeddingSetIds)];
  if (uniqueIds.length === 0) {
    return [];
  }

  const result = await queryStatsDatabase(
    db,
    `
      WITH requested AS (
        SELECT UNNEST($1::text[]) AS embedding_set_id
      ),
      aggregated_files AS (
        SELECT
          fr.embedding_set_id::text AS embedding_set_id,
          COUNT(*)::int AS file_count
        FROM file_records fr
        JOIN requested r ON r.embedding_set_id = fr.embedding_set_id::text
        GROUP BY fr.embedding_set_id::text
      ),
      aggregated_chunks AS (
        SELECT
          c.embedding_set_id::text AS embedding_set_id,
          COUNT(*)::int AS chunk_count,
          COUNT(*) FILTER (WHERE c.embedding IS NOT NULL)::int AS embedded_chunk_count,
          COUNT(*) FILTER (WHERE c.embedding IS NULL)::int AS pending_chunk_count
        FROM file_chunks c
        JOIN requested r ON r.embedding_set_id = c.embedding_set_id::text
        GROUP BY c.embedding_set_id::text
      ),
      refreshed AS (
        INSERT INTO collection_indexing_stats (
          embedding_set_id,
          file_count,
          chunk_count,
          embedded_chunk_count,
          pending_chunk_count,
          dirty,
          last_refreshed_at
        )
        SELECT
          s.id,
          COALESCE(af.file_count, 0) AS file_count,
          COALESCE(ac.chunk_count, 0) AS chunk_count,
          COALESCE(ac.embedded_chunk_count, 0) AS embedded_chunk_count,
          COALESCE(ac.pending_chunk_count, 0) AS pending_chunk_count,
          FALSE,
          NOW()
        FROM embedding_sets s
        JOIN requested r ON r.embedding_set_id = s.id::text
        LEFT JOIN aggregated_files af ON af.embedding_set_id = s.id::text
        LEFT JOIN aggregated_chunks ac ON ac.embedding_set_id = s.id::text
        ON CONFLICT (embedding_set_id) DO UPDATE SET
          file_count = EXCLUDED.file_count,
          chunk_count = EXCLUDED.chunk_count,
          embedded_chunk_count = EXCLUDED.embedded_chunk_count,
          pending_chunk_count = EXCLUDED.pending_chunk_count,
          dirty = FALSE,
          last_refreshed_at = EXCLUDED.last_refreshed_at
        RETURNING
          embedding_set_id AS "embeddingSetId",
          file_count AS "fileCount",
          chunk_count AS "chunkCount",
          embedded_chunk_count AS "embeddedChunkCount",
          pending_chunk_count AS "pendingChunkCount",
          dirty,
          last_refreshed_at AS "lastRefreshedAt"
      )
      SELECT *
        FROM refreshed
       ORDER BY "embeddingSetId"
    `,
    [uniqueIds],
    options
  );

  return (result.rows as CollectionIndexingStatsRow[]).map(mapStatsRow);
}
