import type { EmbeddingDistance } from '../models/embedding-set.js';

/**
 * Embedding-space listing contract shared by the raw and Drizzle
 * embedding-sets repositories (BST-989 slice 1): one SQL surface, one row
 * shape, one reader — the pair must return byte-identical listings.
 */

export interface ListEmbeddingSpacesOptions {
  readonly includeStats?: boolean;
}

export interface EmbeddingSpaceStats {
  /**
   * Average tokens across chunks that have a recorded token_count; uncounted chunks are excluded.
   */
  readonly averageTokensPerChunk: number;
  readonly embeddedChunks: number;
  readonly fileCount: number;
  readonly tokenizedChunkCount: number;
  readonly totalChunks: number;
  readonly totalTokens: number;
}

export interface EmbeddingSpaceListing {
  readonly createdAt: string;
  readonly description: string | null;
  readonly dimensions: number;
  readonly distance: EmbeddingDistance | null;
  readonly id: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly name: string | null;
  readonly stats?: EmbeddingSpaceStats;
  readonly statsUnavailableReason?: string;
}

interface EmbeddingSpaceListingRow {
  readonly averageTokensPerChunk?: number | string | null;
  readonly createdAt: string;
  readonly description: string | null;
  readonly dimensions: number | string;
  readonly distance: EmbeddingDistance | null;
  readonly embeddedChunks?: number | string | null;
  readonly fileCount?: number | string | null;
  readonly id: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly name: string | null;
  readonly tokenizedChunkCount?: number | string | null;
  readonly totalChunks?: number | string | null;
  readonly totalTokens?: number | string | null;
}

function readFiniteNumber(value: number | string, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid embedding space ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function readOptionalFiniteNumber(
  value: number | string | null | undefined,
  fieldName: string
): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return readFiniteNumber(value, fieldName);
}

function mapEmbeddingSpaceListingRow(value: unknown): EmbeddingSpaceListingRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Embedding space listing row must be an object.');
  }
  return value as EmbeddingSpaceListingRow;
}

function readEmbeddingSpaceListing(
  row: EmbeddingSpaceListingRow,
  options: ListEmbeddingSpacesOptions
): EmbeddingSpaceListing {
  const listing: EmbeddingSpaceListing = {
    createdAt: row.createdAt,
    description: row.description,
    dimensions: readFiniteNumber(row.dimensions, 'dimensions'),
    distance: row.distance as EmbeddingDistance | null,
    id: row.id,
    modelId: row.modelId,
    modelKey: row.modelKey,
    name: row.name,
  };
  if (options.includeStats !== true) {
    return listing;
  }
  return {
    ...listing,
    stats: {
      averageTokensPerChunk: readOptionalFiniteNumber(
        row.averageTokensPerChunk,
        'averageTokensPerChunk'
      ),
      embeddedChunks: readOptionalFiniteNumber(row.embeddedChunks, 'embeddedChunks'),
      fileCount: readOptionalFiniteNumber(row.fileCount, 'fileCount'),
      tokenizedChunkCount: readOptionalFiniteNumber(row.tokenizedChunkCount, 'tokenizedChunkCount'),
      totalChunks: readOptionalFiniteNumber(row.totalChunks, 'totalChunks'),
      totalTokens: readOptionalFiniteNumber(row.totalTokens, 'totalTokens'),
    },
  };
}

const LIST_EMBEDDING_SPACES_SQL = `SELECT
   id,
   name,
   description,
   model_key AS "modelKey",
   model_id AS "modelId",
   dimensions,
   distance,
   created_at AS "createdAt"
 FROM embedding_sets
 ORDER BY created_at DESC`;

const LIST_EMBEDDING_SPACES_WITH_STATS_SQL = `WITH file_stats AS (
   SELECT
     embedding_set_id,
     COUNT(*)::text AS file_count
   FROM file_records
   WHERE embedding_set_id IS NOT NULL
   GROUP BY embedding_set_id
 ),
 chunk_stats AS (
   SELECT
     embedding_set_id,
     COUNT(*)::text AS total_chunks,
     COUNT(*) FILTER (WHERE embedding IS NOT NULL)::text AS embedded_chunks,
     COUNT(token_count)::text AS tokenized_chunk_count,
     COALESCE(SUM(token_count), 0)::text AS total_tokens,
     COALESCE(AVG(token_count), 0)::text AS average_tokens_per_chunk
   FROM file_chunks
   WHERE embedding_set_id IS NOT NULL
   GROUP BY embedding_set_id
 )
 SELECT
   es.id,
   es.name,
   es.description,
   es.model_key AS "modelKey",
   es.model_id AS "modelId",
   es.dimensions,
   es.distance,
   es.created_at AS "createdAt",
   COALESCE(fs.file_count, '0') AS "fileCount",
   COALESCE(cs.total_chunks, '0') AS "totalChunks",
   COALESCE(cs.embedded_chunks, '0') AS "embeddedChunks",
   COALESCE(cs.tokenized_chunk_count, '0') AS "tokenizedChunkCount",
   COALESCE(cs.total_tokens, '0') AS "totalTokens",
   COALESCE(cs.average_tokens_per_chunk, '0') AS "averageTokensPerChunk"
 FROM embedding_sets es
 LEFT JOIN file_stats fs ON fs.embedding_set_id = es.id
 LEFT JOIN chunk_stats cs ON cs.embedding_set_id = es.id
 ORDER BY es.created_at DESC`;

/**
 * The ONE pairing of SQL choice and reader options (review finding on
 * BST-989 slice 1): callers hand over their query seam and the module owns
 * both halves, so the stats SQL and the stats reader cannot drift apart.
 */
export async function runListEmbeddingSpacesQuery(
  query: (sql: string) => Promise<{ rows: unknown[] }>,
  options: ListEmbeddingSpacesOptions = {}
): Promise<EmbeddingSpaceListing[]> {
  const result = await query(
    options.includeStats === true ? LIST_EMBEDDING_SPACES_WITH_STATS_SQL : LIST_EMBEDDING_SPACES_SQL
  );
  return result.rows.map((row) =>
    readEmbeddingSpaceListing(mapEmbeddingSpaceListingRow(row), options)
  );
}
