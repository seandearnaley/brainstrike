import type { IDatabase } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';

const workerDbIoLogger = createLogger('EmbeddingWorkerDbIo');

export interface EmbedChunkRow {
  content: string;
  contentHash: string;
  embeddingHash?: string | null;
  embeddingSetId?: string | null;
  id: string;
}

export interface ChunkEmbeddingUpdate {
  embedding: number[];
  embeddingHash: string;
  embeddingSetId: string;
  id: string;
}

export async function loadChunk(db: IDatabase, id: string): Promise<EmbedChunkRow | null> {
  const res = await db.query<EmbedChunkRow>(
    `SELECT id, content, content_hash AS "contentHash", embedding_hash AS "embeddingHash", embedding_set_id AS "embeddingSetId"
     FROM file_chunks WHERE id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function loadChunksBatch(
  db: IDatabase,
  ids: string[],
  idType: string
): Promise<EmbedChunkRow[]> {
  if (ids.length === 0) {
    return [];
  }

  const sql =
    idType === 'uuid'
      ? `SELECT id, content, content_hash AS "contentHash", embedding_hash AS "embeddingHash", embedding_set_id AS "embeddingSetId"
     FROM file_chunks WHERE id = ANY($1::uuid[])`
      : `SELECT id, content, content_hash AS "contentHash", embedding_hash AS "embeddingHash", embedding_set_id AS "embeddingSetId"
     FROM file_chunks WHERE id = ANY($1::text[])`;

  const res = await db.query<EmbedChunkRow>(sql, [ids]);
  return res.rows;
}

export async function resolveIdType(db: IDatabase, table: string): Promise<string> {
  type IdTypeProbe = 'information_schema' | 'pg_catalog';
  const normalizeType = (value: unknown): 'uuid' | 'text' | null => {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.toLowerCase();
    if (normalized === 'uuid') {
      return 'uuid';
    }
    if (normalized === 'text') {
      return 'text';
    }
    return null;
  };
  const errors: string[] = [];
  const recordProbeError = (probe: IdTypeProbe, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${probe}: ${message}`);
    workerDbIoLogger.error('Failed to resolve id type probe for embedding worker', {
      message,
      probe,
      table,
    });
  };

  try {
    const res = await db.query<{ dataType: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS "dataType"
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = $1
          AND a.attname = 'id'
          AND NOT a.attisdropped
        LIMIT 1`,
      [table]
    );
    const type = normalizeType(res.rows[0]?.dataType);
    if (type) {
      return type;
    }
  } catch (error) {
    recordProbeError('pg_catalog', error);
  }

  try {
    const res = await db.query<{ dataType: string }>(
      `SELECT data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = 'id'
        LIMIT 1`,
      [table]
    );
    const type = normalizeType(res.rows[0]?.dataType);
    if (type) {
      return type;
    }
  } catch (error) {
    recordProbeError('information_schema', error);
  }

  const suffix = errors.length > 0 ? ` Details: ${errors.join('; ')}` : '';
  throw new Error(`Failed to resolve ID type for ${table}.id.${suffix}`);
}

function readRowString(row: Record<string, unknown> | undefined, keys: readonly string[]): string {
  if (!row) {
    return '';
  }

  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string') {
      return value;
    }
  }

  return '';
}

export async function assertVectorEmbeddingColumn(db: IDatabase): Promise<void> {
  try {
    const res = await db.query<Record<string, unknown>>(
      `SELECT data_type AS "dataType", udt_name AS "udtName"
       FROM information_schema.columns
       WHERE table_name = 'file_chunks'
         AND column_name = 'embedding'
       LIMIT 1`
    );
    const row = res.rows[0];
    const columnType = `${readRowString(row, ['udtName', 'udt_name', 'udtname'])} ${readRowString(
      row,
      ['dataType', 'data_type', 'datatype']
    )}`.toLowerCase();

    if (columnType.includes('vector')) {
      return;
    }
    if (columnType.trim().length > 0) {
      throw new Error(`file_chunks.embedding must be a vector column, found: ${columnType}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('must be a vector column')) {
      throw error;
    }
    workerDbIoLogger.debug('Failed to resolve file_chunks.embedding column type', { error });
  }

  try {
    const res = await db.query<{ one: number }>(
      "SELECT 1 as one FROM pg_extension WHERE extname = 'vector'"
    );
    if (Array.isArray(res.rows) && res.rows.length > 0) {
      return;
    }
  } catch (error) {
    workerDbIoLogger.debug('Failed to detect pgvector extension for embedding writes', {
      error,
    });
  }

  workerDbIoLogger.debug(
    'Could not verify file_chunks.embedding column type; continuing with vector writes because initialized Brainstrike databases require pgvector.'
  );
}

export async function updateChunkEmbeddingBatch(
  db: IDatabase,
  updates: ChunkEmbeddingUpdate[],
  idType: string
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const now = new Date().toISOString();

  const ids = updates.map((u) => u.id);
  const embeddingSetIds = updates.map((u) => u.embeddingSetId);
  const embeddingHashes = updates.map((u) => u.embeddingHash);
  const embeddings = updates.map((u) => `[${u.embedding.join(',')}]`);

  const sql =
    idType === 'uuid'
      ? `UPDATE file_chunks AS fc
         SET
           embedding = t.embedding::vector,
           embedding_set_id = t.embedding_set_id,
           embedding_updated_at = $1,
           embedding_hash = t.embedding_hash,
           updated_at = $1
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[])
         AS t(id, embedding, embedding_set_id, embedding_hash)
       WHERE fc.id = t.id`
      : `UPDATE file_chunks AS fc
         SET
           embedding = t.embedding::vector,
           embedding_set_id = t.embedding_set_id,
           embedding_updated_at = $1,
           embedding_hash = t.embedding_hash,
           updated_at = $1
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
         AS t(id, embedding, embedding_set_id, embedding_hash)
       WHERE fc.id = t.id`;

  await db.query(sql, [now, ids, embeddings, embeddingSetIds, embeddingHashes]);
}

const embeddingSetDimensionCache = new Map<string, number>();

export async function resolveEmbeddingSetDimension(
  db: IDatabase,
  embeddingSetId: string
): Promise<number> {
  const cached = embeddingSetDimensionCache.get(embeddingSetId);
  if (typeof cached === 'number') {
    return cached;
  }

  const res = await db.query<{ dimensions?: number }>(
    'SELECT dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
    [embeddingSetId]
  );
  const raw = res.rows[0]?.dimensions;
  const dimension = typeof raw === 'number' ? raw : Number(raw ?? 0);
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error(`Embedding set ${embeddingSetId} is missing valid dimension metadata.`);
  }
  embeddingSetDimensionCache.set(embeddingSetId, dimension);
  return dimension;
}
