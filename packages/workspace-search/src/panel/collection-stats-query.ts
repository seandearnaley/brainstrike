import type { EmbeddingSetSystemRole } from '@brainstrike/db';

/**
 * Row shape returned by {@link COLLECTION_STATS_QUERY}.
 *
 * The join (embedding_sets LEFT JOIN collection_indexing_stats) is copied
 * verbatim from `packages/vector-management/src/collection-select/collection-select.tsx`
 * (`COLLECTIONS_QUERY`); only the select-list/aliases are trimmed to what the
 * panel controls need, plus `pending_chunk_count` for coverage-state detection.
 */
export interface CollectionStatsRow {
  chunkCount: null | number | string;
  embeddedChunkCount: null | number | string;
  fileCount: null | number | string;
  id: string;
  name: null | string;
  pendingChunkCount: null | number | string;
  systemRole: EmbeddingSetSystemRole | null;
}

export const COLLECTION_STATS_QUERY = `
    SELECT
      s.id,
      s.name,
      s.system_role AS "systemRole",
      stats.file_count AS "fileCount",
      stats.chunk_count AS "chunkCount",
      stats.embedded_chunk_count AS "embeddedChunkCount",
      stats.pending_chunk_count AS "pendingChunkCount"
    FROM embedding_sets s
    LEFT JOIN collection_indexing_stats stats ON stats.embedding_set_id = s.id
    ORDER BY s.created_at DESC, s.id DESC
  `.trim();

export function toStatsNumber(value: null | number | string | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Resolves the row for the currently selected embedding set. `collectionId
 * === null` means "resolve the workspace-index set" (the store's
 * documented convention — see `workspace-search-store.ts`).
 */
export function resolveEffectiveStatsRow(
  rows: readonly CollectionStatsRow[],
  collectionId: string | null
): CollectionStatsRow | null {
  if (collectionId) {
    return rows.find((row) => row.id === collectionId) ?? null;
  }
  return rows.find((row) => row.systemRole === 'workspace-index') ?? null;
}
