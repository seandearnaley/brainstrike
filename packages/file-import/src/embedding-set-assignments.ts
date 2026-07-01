export interface EmbeddingSetAssignmentSqlPort {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  readonly runtimeEngine?: 'pglite' | 'turso';
}

const TURSO_MAX_SQLITE_PARAMS = 900;
const TURSO_RECORD_ASSIGNMENT_EXTRA_PARAMS = 2;
const TURSO_ASSIGNMENT_IDS_PER_BATCH =
  TURSO_MAX_SQLITE_PARAMS - TURSO_RECORD_ASSIGNMENT_EXTRA_PARAMS;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function chunkIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += TURSO_ASSIGNMENT_IDS_PER_BATCH) {
    chunks.push(ids.slice(index, index + TURSO_ASSIGNMENT_IDS_PER_BATCH));
  }
  return chunks;
}

async function backfillTursoEmbeddingSetAssignments(
  sql: EmbeddingSetAssignmentSqlPort,
  embeddingSetId: string,
  uniqueIds: readonly string[]
): Promise<void> {
  for (const idChunk of chunkIds(uniqueIds)) {
    const idPlaceholders = placeholders(idChunk.length);

    await sql.query(
      `UPDATE file_records
         SET embedding_set_id = ?
       WHERE id IN (${idPlaceholders})
         AND (embedding_set_id IS NULL OR embedding_set_id <> ?)`,
      [embeddingSetId, ...idChunk, embeddingSetId]
    );

    await sql.query(
      `UPDATE file_chunks
         SET embedding_set_id = ?
       WHERE file_record_id IN (${idPlaceholders})
         AND embedding_set_id IS NULL`,
      [embeddingSetId, ...idChunk]
    );
  }
}

export async function backfillEmbeddingSetAssignments(
  sql: EmbeddingSetAssignmentSqlPort | null,
  embeddingSetId: string | null,
  fileIds: readonly string[]
): Promise<void> {
  if (!(sql && embeddingSetId) || fileIds.length === 0) {
    return;
  }

  const uniqueIds = Array.from(new Set(fileIds.filter((id): id is string => Boolean(id))));
  if (uniqueIds.length === 0) {
    return;
  }

  if (sql.runtimeEngine === 'turso') {
    await backfillTursoEmbeddingSetAssignments(sql, embeddingSetId, uniqueIds);
    return;
  }

  const params = [embeddingSetId, uniqueIds];

  await sql.query(
    `UPDATE file_records
       SET embedding_set_id = $1
     WHERE id::text = ANY($2::text[])
       AND (embedding_set_id IS NULL OR embedding_set_id IS DISTINCT FROM $1)`,
    params
  );

  await sql.query(
    `UPDATE file_chunks
       SET embedding_set_id = $1
     WHERE file_record_id::text = ANY($2::text[])
       AND embedding_set_id IS NULL`,
    params
  );
}
