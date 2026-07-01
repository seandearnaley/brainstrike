import {
  makeLiveQueryKey,
  useBrainstrikeLiveQuery,
  useFileRecordRepository,
  useOptionalPGliteDatabase,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useMemo } from 'react';
import type { FileCollectionStatus } from '../types/file-collection-status';

const logger = createLogger('useFileCollectionStatus');

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
  last_indexed: string | null;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  other_collections: string | number;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  searchable_chunks: string | number;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  total_chunks: string | number;
}

/**
 * Type guard to validate database row has required fields
 */
function isValidFileStatusRow(row: unknown): row is FileStatusRow {
  if (typeof row !== 'object' || row === null) {
    return false;
  }

  const r = row as Record<string, unknown>;
  return (
    typeof r['file_id'] === 'string' &&
    typeof r['file_name'] === 'string' &&
    typeof r['file_path'] === 'string' &&
    (typeof r['searchable_chunks'] === 'string' || typeof r['searchable_chunks'] === 'number') &&
    (typeof r['total_chunks'] === 'string' || typeof r['total_chunks'] === 'number') &&
    (typeof r['other_collections'] === 'string' || typeof r['other_collections'] === 'number') &&
    (r['last_indexed'] === null || typeof r['last_indexed'] === 'string')
  );
}

/**
 * Maps database row to FileCollectionStatus
 */
function mapRowToStatus(row: FileStatusRow): FileCollectionStatus {
  const searchableChunksCount = Number(row.searchable_chunks ?? 0) || 0;
  const totalChunksCount = Number(row.total_chunks ?? 0) || 0;
  const otherCollectionsCount = Number(row.other_collections ?? 0) || 0;

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
  const pgliteDb = useOptionalPGliteDatabase();
  const repository = useFileRecordRepository();
  const repositoryStatusLoader = useMemo(() => {
    if (pgliteDb || !repository || typeof repository.getFileCollectionStatuses !== 'function') {
      return null;
    }
    return repository.getFileCollectionStatuses.bind(repository);
  }, [pgliteDb, repository]);
  const liveQueryEnabled = Boolean(activeCollectionId && pgliteDb);
  const params = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? ([activeCollectionId] as const) : undefined),
    [activeCollectionId]
  );

  const { rows, error } = useBrainstrikeLiveQuery<FileStatusRow>({
    cacheKey: makeLiveQueryKey('file-collection-status', activeCollectionId),
    query: FILE_STATUS_QUERY,
    ...(params ? { params } : {}),
    mode: 'incremental',
    key: 'file_id',
    enabled: liveQueryEnabled,
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
      map.set(row.file_id, mapRowToStatus(row));
    }
    return map;
  }, [rows, activeCollectionId]);

  const getFileStatus = useCallback(
    async (fileIds: string[]): Promise<FileCollectionStatus[]> => {
      if (!activeCollectionId || fileIds.length === 0) {
        return [];
      }

      if (!liveQueryEnabled) {
        if (!repositoryStatusLoader) {
          throw new Error(
            'File collection status requires live query support or repository status snapshots.'
          );
        }
        return [...(await repositoryStatusLoader(activeCollectionId, fileIds))];
      }

      return fileIds
        .map((id) => statusMap.get(id))
        .filter((status): status is FileCollectionStatus => Boolean(status));
    },
    [activeCollectionId, liveQueryEnabled, repositoryStatusLoader, statusMap]
  );

  return { getFileStatus, error };
}
