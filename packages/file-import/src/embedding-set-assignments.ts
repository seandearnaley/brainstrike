export interface EmbeddingSetAssignmentSqlPort {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  readonly runtimeEngine?: 'pglite' | 'turso';
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

async function backfillTursoEmbeddingSetAssignments(
  sql: EmbeddingSetAssignmentSqlPort,
  embeddingSetId: string,
  uniqueIds: readonly string[]
): Promise<void> {
  const idPlaceholders = placeholders(uniqueIds.length);

  await sql.query(
    `UPDATE file_records
       SET embedding_set_id = ?
     WHERE id IN (${idPlaceholders})
       AND (embedding_set_id IS NULL OR embedding_set_id <> ?)`,
    [embeddingSetId, ...uniqueIds, embeddingSetId]
  );

  await sql.query(
    `UPDATE file_chunks
       SET embedding_set_id = ?
     WHERE file_record_id IN (${idPlaceholders})
       AND embedding_set_id IS NULL`,
    [embeddingSetId, ...uniqueIds]
  );
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
