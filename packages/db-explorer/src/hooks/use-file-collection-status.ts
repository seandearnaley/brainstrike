import { usePGliteDatabase } from '@brainstrike/db';
import { useCallback } from 'react';
import type { FileCollectionStatus } from '../types/file-collection-status';

/**
 * Database row returned by file status query
 * Uses snake_case to match database column naming
 */
interface FileStatusRow {
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  file_id: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  file_name: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  file_path: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  searchable_chunks: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  total_chunks: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  other_collections: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  last_indexed: string | null;
}

/**
 * Maps database row to FileCollectionStatus
 */
function mapRowToStatus(row: FileStatusRow): FileCollectionStatus {
  const searchableChunksCount = Number.parseInt(row.searchable_chunks, 10);
  const totalChunksCount = Number.parseInt(row.total_chunks, 10);
  const otherCollectionsCount = Number.parseInt(row.other_collections, 10);

  const status: FileCollectionStatus = {
    fileId: row.file_id,
    fileName: row.file_name,
    filePath: row.file_path,
    searchableInActive: searchableChunksCount > 0,
    searchableChunksCount,
    totalChunksCount,
    otherCollectionsCount,
  };

  if (row.last_indexed) {
    status.lastIndexedAt = row.last_indexed;
  }

  return status;
}

/**
 * Hook to get file collection status for the active embedding set
 *
 * @param activeCollectionId - The active embedding set ID to check against
 * @returns Object with getFileStatus function to query file statuses
 *
 * @example
 * ```tsx
 * const { getFileStatus } = useFileCollectionStatus(activeCollectionId);
 * const statuses = await getFileStatus(fileIds);
 * ```
 */
export function useFileCollectionStatus(activeCollectionId: string | null) {
  const db = usePGliteDatabase();

  const getFileStatus = useCallback(
    async (fileIds: string[]): Promise<FileCollectionStatus[]> => {
      if (!db || !activeCollectionId || fileIds.length === 0) {
        return [];
      }

      try {
        // Query to get file status for active collection
        // For each file, count:
        // - Total chunks
        // - Chunks with embeddings in active collection
        // - Distinct other collections this file is in
        // - Latest embedding timestamp
        const placeholders = fileIds.map((_, i) => `$${i + 2}`).join(', ');
        const query = `
          SELECT
            fr.id AS file_id,
            fr.name AS file_name,
            fr.path AS file_path,
            COUNT(fc.id) FILTER (
              WHERE fc.embedding_set_id = $1
              AND fc.embedding IS NOT NULL
            ) AS searchable_chunks,
            COUNT(fc.id) AS total_chunks,
            COUNT(DISTINCT fc.embedding_set_id) FILTER (
              WHERE fc.embedding_set_id IS NOT NULL
              AND fc.embedding_set_id != $1
            ) AS other_collections,
            MAX(fc.embedding_updated_at) AS last_indexed
          FROM file_records fr
          LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
          WHERE fr.id IN (${placeholders})
          GROUP BY fr.id, fr.name, fr.path
          ORDER BY fr.created_at DESC
        `.trim();

        const result = await db.query(query, [activeCollectionId, ...fileIds]);

        return result.rows.map((row) => mapRowToStatus(row as FileStatusRow));
      } catch (error) {
        console.error('[useFileCollectionStatus] Failed to get file status:', error);
        return [];
      }
    },
    [db, activeCollectionId]
  );

  return { getFileStatus };
}
