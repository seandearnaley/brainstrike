import { usePGliteLiveQuery } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useMemo } from 'react';
import type { FileCollectionStatus } from '../types/file-collection-status';

const logger = createLogger('useFileCollectionStatus');

/**
 * Database row returned by file status query.
 * IPC transforms snake_case to camelCase automatically.
 */
type FileStatusRow = {
  fileId: string;
  fileName: string;
  filePath: string;
  searchableChunks: string | number;
  totalChunks: string | number;
  otherCollections: string | number;
  lastIndexed: string | null;
};

/**
 * Type guard to validate database row has required fields
 */
function isValidFileStatusRow(row: unknown): row is FileStatusRow {
  if (typeof row !== 'object' || row === null) {
    return false;
  }

  const r = row as Record<string, unknown>;
  return (
    typeof r['fileId'] === 'string' &&
    typeof r['fileName'] === 'string' &&
    typeof r['filePath'] === 'string' &&
    (typeof r['searchableChunks'] === 'string' || typeof r['searchableChunks'] === 'number') &&
    (typeof r['totalChunks'] === 'string' || typeof r['totalChunks'] === 'number') &&
    (typeof r['otherCollections'] === 'string' || typeof r['otherCollections'] === 'number') &&
    (r['lastIndexed'] === null || typeof r['lastIndexed'] === 'string')
  );
}

/**
 * Maps database row to FileCollectionStatus
 */
function mapRowToStatus(row: FileStatusRow): FileCollectionStatus {
  const searchableChunksCount = Number(row.searchableChunks ?? 0) || 0;
  const totalChunksCount = Number(row.totalChunks ?? 0) || 0;
  const otherCollectionsCount = Number(row.otherCollections ?? 0) || 0;

  const status: FileCollectionStatus = {
    fileId: row.fileId,
    fileName: row.fileName,
    filePath: row.filePath,
    searchableInActive: searchableChunksCount > 0,
    searchableChunksCount,
    totalChunksCount,
    otherCollectionsCount,
  };

  if (row.lastIndexed) {
    status.lastIndexedAt = row.lastIndexed;
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
const FILE_STATUS_QUERY = `
  WITH target AS (SELECT $1::text AS embedding_set_id)
  SELECT
    fr.id AS file_id,
    fr.name AS file_name,
    fr.path AS file_path,
    COUNT(fc.id) FILTER (
      WHERE fc.embedding_set_id = target.embedding_set_id
        AND fc.embedding IS NOT NULL
    ) AS searchable_chunks,
    COUNT(fc.id) AS total_chunks,
    COUNT(DISTINCT fc.embedding_set_id) FILTER (
      WHERE fc.embedding_set_id IS NOT NULL
        AND fc.embedding_set_id != target.embedding_set_id
    ) AS other_collections,
    MAX(fc.embedding_updated_at) AS last_indexed
  FROM file_records fr
  LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
  JOIN target ON fr.embedding_set_id = target.embedding_set_id
  GROUP BY fr.id, fr.name, fr.path, fr.created_at
  ORDER BY fr.created_at DESC
`.trim();

export function useFileCollectionStatus(activeCollectionId: string | null) {
  const params = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? ([activeCollectionId] as const) : undefined),
    [activeCollectionId]
  );

  const { rows, error } = usePGliteLiveQuery<FileStatusRow>({
    query: FILE_STATUS_QUERY,
    ...(params ? { params } : {}),
    mode: 'incremental',
    key: 'fileId',
    enabled: Boolean(activeCollectionId),
  });

  const statusMap = useMemo(() => {
    if (!activeCollectionId) {
      return new Map<string, FileCollectionStatus>();
    }

    const map = new Map<string, FileCollectionStatus>();
    for (const row of rows) {
      if (!isValidFileStatusRow(row)) {
        logger.warn('Invalid row data returned from file status query', { row });
        continue;
      }
      map.set(row.fileId, mapRowToStatus(row));
    }
    return map;
  }, [rows, activeCollectionId]);

  const getFileStatus = useCallback(
    async (fileIds: string[]): Promise<FileCollectionStatus[]> => {
      if (!activeCollectionId || fileIds.length === 0) {
        return [];
      }

      return fileIds
        .map((id) => statusMap.get(id))
        .filter((status): status is FileCollectionStatus => Boolean(status));
    },
    [activeCollectionId, statusMap]
  );

  return { getFileStatus, error };
}
