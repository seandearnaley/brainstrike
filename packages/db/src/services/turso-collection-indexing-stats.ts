import type {
  BrainstrikeDbTransactionClient,
  BrainstrikeDbWorkOptions,
} from '../architecture/brainstrike-db-client-contract.js';

function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export async function markTursoCollectionIndexingStatsDirty(
  db: BrainstrikeDbTransactionClient,
  embeddingSetIds: readonly string[],
  options?: BrainstrikeDbWorkOptions
): Promise<void> {
  const uniqueIds = [...new Set(embeddingSetIds)];
  if (uniqueIds.length === 0) {
    return;
  }
  await db.exec(
    `UPDATE collection_indexing_stats
        SET dirty = 1
      WHERE embedding_set_id IN (${createPlaceholders(uniqueIds.length)})`,
    uniqueIds,
    options
  );
}

export async function refreshTursoCollectionIndexingStats(
  db: BrainstrikeDbTransactionClient,
  embeddingSetIds: readonly string[]
): Promise<void> {
  const uniqueIds = [...new Set(embeddingSetIds)];
  if (uniqueIds.length === 0) {
    return;
  }

  for (const embeddingSetId of uniqueIds) {
    await db.exec(
      `INSERT INTO collection_indexing_stats (
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
         (
           SELECT COUNT(*)
             FROM file_records fr
            WHERE fr.embedding_set_id = s.id
         ),
         (
           SELECT COUNT(*)
             FROM file_chunks c
             JOIN file_records fr ON fr.id = c.file_record_id
            WHERE c.embedding_set_id = s.id
               OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = s.id)
         ),
         (
           SELECT COUNT(*)
             FROM file_chunks c
             JOIN file_records fr ON fr.id = c.file_record_id
            WHERE (
                    c.embedding_set_id = s.id
                    OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = s.id)
                  )
              AND c.embedding IS NOT NULL
         ),
         (
           SELECT COUNT(*)
             FROM file_chunks c
             JOIN file_records fr ON fr.id = c.file_record_id
            WHERE (
                    c.embedding_set_id = s.id
                    OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = s.id)
                  )
              AND c.embedding IS NULL
         ),
         0,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         FROM embedding_sets s
        WHERE s.id = ?
       ON CONFLICT (embedding_set_id) DO UPDATE SET
         file_count = excluded.file_count,
         chunk_count = excluded.chunk_count,
         embedded_chunk_count = excluded.embedded_chunk_count,
         pending_chunk_count = excluded.pending_chunk_count,
         dirty = 0,
         last_refreshed_at = excluded.last_refreshed_at`,
      [embeddingSetId]
    );
  }
}
