import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import { useMemo } from 'react';
import {
  COLLECTION_STATS_QUERY,
  type CollectionStatsRow,
  resolveEffectiveStatsRow,
  toStatsNumber,
} from './collection-stats-query';

export interface SearchCoverageBannerProps {
  collectionId: string | null;
  rootIds: readonly string[];
}

interface TotalFilesRow {
  total: null | number | string;
}

const TOTAL_WORKSPACE_FILES_QUERY =
  'SELECT COUNT(*)::int AS total FROM file_records WHERE root_id = ANY($1::text[])';

/**
 * Coverage banner for the selected embedding set (workspace-index when
 * `collectionId` is null): "Indexing…" while chunks are pending, nothing
 * once the set covers every workspace file, or "N of M files indexed" for
 * a partially-covered set (e.g. import ran but embedding hasn't reached
 * every file yet).
 */
export function SearchCoverageBanner({ collectionId, rootIds }: SearchCoverageBannerProps) {
  const { rows } = usePGliteLiveQuery<CollectionStatsRow>({
    cacheKey: makeLiveQueryKey('workspace-search-collection-stats'),
    key: 'id',
    mode: 'incremental',
    query: COLLECTION_STATS_QUERY,
  });

  const { rows: totalRows } = usePGliteLiveQuery<TotalFilesRow>({
    cacheKey: makeLiveQueryKey('workspace-search-total-files', rootIds),
    params: [rootIds],
    query: TOTAL_WORKSPACE_FILES_QUERY,
  });

  const statsRow = useMemo(
    () => resolveEffectiveStatsRow(rows, collectionId),
    [rows, collectionId]
  );

  if (!statsRow) {
    return null;
  }

  const pendingChunkCount = toStatsNumber(statsRow.pendingChunkCount);
  const embeddedChunkCount = toStatsNumber(statsRow.embeddedChunkCount);
  const chunkCount = toStatsNumber(statsRow.chunkCount);
  const fileCount = toStatsNumber(statsRow.fileCount);
  const totalFiles = toStatsNumber(totalRows[0]?.total);

  if (pendingChunkCount > 0) {
    return (
      <p className="text-muted-foreground text-xs" role="status">
        Indexing… ({embeddedChunkCount}/{chunkCount} chunks, {fileCount}/{totalFiles} files)
      </p>
    );
  }

  if (fileCount >= totalFiles) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs" role="status">
      {fileCount} of {totalFiles} files indexed
    </p>
  );
}
