import { usePGliteDatabase } from '@brainstrike/db';
import { useCallback, useState } from 'react';
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
 * Type guard to validate database row has required fields
 */
function isValidFileStatusRow(row: unknown): row is FileStatusRow {
  if (typeof row !== 'object' || row === null) return false;

  const r = row as Record<string, unknown>;
  return (
    typeof r['file_id'] === 'string' &&
    typeof r['file_name'] === 'string' &&
    typeof r['file_path'] === 'string' &&
    typeof r['searchable_chunks'] === 'string' &&
    typeof r['total_chunks'] === 'string' &&
    typeof r['other_collections'] === 'string' &&
    (r['last_indexed'] === null || typeof r['last_indexed'] === 'string')
  );
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
 * @returns Object with getFileStatus function to query file statuses and error state
 *
 * @example
 * ```tsx
 * const { getFileStatus, error } = useFileCollectionStatus(activeCollectionId);
 * const statuses = await getFileStatus(fileIds);
 * if (error) {
 *   // Handle error state
 * }
 * ```
 */
export function useFileCollectionStatus(activeCollectionId: string | null) {
  const db = usePGliteDatabase();
  const [error, setError] = useState<Error | null>(null);

  const getFileStatus = useCallback(
    async (fileIds: string[]): Promise<FileCollectionStatus[]> => {
      // Clear previous errors
      setError(null);

      if (!db || !activeCollectionId || fileIds.length === 0) {
        return [];
      }

      // Validate input
      if (fileIds.length > 1000) {
        const err = new Error('Cannot query more than 1000 files at once');
        setError(err);
        console.error('[useFileCollectionStatus]', err);
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
          GROUP BY fr.id, fr.name, fr.path, fr.created_at
          ORDER BY fr.created_at DESC
        `.trim();

        const result = await db.query(query, [activeCollectionId, ...fileIds]);

        // Validate and map rows with runtime type checking
        const validatedRows = result.rows.filter((row): row is FileStatusRow => {
          const isValid = isValidFileStatusRow(row);
          if (!isValid) {
            console.warn('[useFileCollectionStatus] Invalid row data:', row);
          }
          return isValid;
        });

        return validatedRows.map(mapRowToStatus);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        setError(err);
        console.error('[useFileCollectionStatus] Failed to get file status:', err);
        return [];
      }
    },
    [db, activeCollectionId]
  );

  return { getFileStatus, error };
}
