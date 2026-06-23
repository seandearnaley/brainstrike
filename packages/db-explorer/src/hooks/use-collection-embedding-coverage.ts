import { makeLiveQueryKey, useBrainstrikeLiveQuery } from '@brainstrike/db';
import { useMemo } from 'react';

export type CollectionEmbeddingCoverageStatus =
  | 'idle'
  | 'fully_indexed'
  | 'needs_reindex'
  | 'partial_source_ranges';

export interface CollectionEmbeddingCoverageSnapshot {
  chunksMissingSourceRange: number;
  pendingReindexFileCount: number;
  status: CollectionEmbeddingCoverageStatus;
  totalChunks: number;
  totalFiles: number;
}

interface CollectionCoverageRow {
  chunksmissing: number;
  embeddingsetid: string;
  pendingreindexfiles: number;
  totalchunks: number;
  totalfiles: number;
}

const COLLECTION_EMBEDDING_COVERAGE_QUERY = `
  WITH target AS (SELECT $1::text AS embedding_set_id)
  SELECT
    target.embedding_set_id AS embeddingsetid,
    COUNT(DISTINCT fr.id)::int AS totalfiles,
    COUNT(fc.id)::int AS totalchunks,
    COUNT(DISTINCT fr.id) FILTER (WHERE fr.chunks_processed_at IS NULL)::int AS pendingreindexfiles,
    COUNT(fc.id) FILTER (
      WHERE fc.start_line IS NULL
         OR fc.end_line IS NULL
         OR fc.start_offset IS NULL
         OR fc.end_offset IS NULL
    )::int AS chunksmissing
  FROM file_records fr
  LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
  JOIN target ON fr.embedding_set_id = target.embedding_set_id
  GROUP BY target.embedding_set_id
`.trim();

function isValidCoverageRow(row: unknown): row is CollectionCoverageRow {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const record = row as Record<string, unknown>;
  return (
    typeof record['embeddingsetid'] === 'string' &&
    typeof record['totalfiles'] === 'number' &&
    typeof record['totalchunks'] === 'number' &&
    typeof record['pendingreindexfiles'] === 'number' &&
    typeof record['chunksmissing'] === 'number'
  );
}

export function resolveCoverageStatus(
  totalFiles: number,
  pendingReindexFileCount: number,
  chunksMissingSourceRange: number
): CollectionEmbeddingCoverageStatus {
  if (totalFiles === 0) {
    return 'idle';
  }
  if (pendingReindexFileCount > 0) {
    return 'needs_reindex';
  }
  if (chunksMissingSourceRange > 0) {
    return 'partial_source_ranges';
  }
  return 'fully_indexed';
}

function mapRowToSnapshot(row: CollectionCoverageRow): CollectionEmbeddingCoverageSnapshot {
  const pendingReindexFileCount = row.pendingreindexfiles;
  const chunksMissingSourceRange = row.chunksmissing;
  const totalFiles = row.totalfiles;
  const totalChunks = row.totalchunks;
  return {
    pendingReindexFileCount,
    chunksMissingSourceRange,
    totalFiles,
    totalChunks,
    status: resolveCoverageStatus(totalFiles, pendingReindexFileCount, chunksMissingSourceRange),
  };
}

const IDLE_SNAPSHOT: CollectionEmbeddingCoverageSnapshot = {
  pendingReindexFileCount: 0,
  chunksMissingSourceRange: 0,
  totalFiles: 0,
  totalChunks: 0,
  status: 'idle',
};

export function useCollectionEmbeddingCoverage(activeCollectionId: string | null) {
  const params = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? ([activeCollectionId] as const) : undefined),
    [activeCollectionId]
  );

  const { rows, error, loading } = useBrainstrikeLiveQuery<CollectionCoverageRow>({
    cacheKey: makeLiveQueryKey('collection-embedding-coverage', activeCollectionId),
    query: COLLECTION_EMBEDDING_COVERAGE_QUERY,
    ...(params ? { params } : {}),
    mode: 'incremental',
    key: 'embeddingsetid',
    enabled: Boolean(activeCollectionId),
  });

  const snapshot = useMemo(() => {
    if (!activeCollectionId) {
      return IDLE_SNAPSHOT;
    }
    const row = rows[0];
    if (!(row && isValidCoverageRow(row) && row.embeddingsetid === activeCollectionId)) {
      return IDLE_SNAPSHOT;
    }
    return mapRowToSnapshot(row);
  }, [activeCollectionId, rows]);

  return { snapshot, error, loading };
}
