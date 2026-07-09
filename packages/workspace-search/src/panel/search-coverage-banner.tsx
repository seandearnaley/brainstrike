import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import type { WorkspaceCollectionSyncState } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
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
 * Background-indexer states that mean "actively doing work on the managed
 * collection right now" (mirrors db-explorer's embedding-coverage-notice).
 * `idle`/`waiting`/`paused`/`disabled`/`error`/`blocked` are not active.
 */
const ACTIVE_SYNC_STATES = new Set<WorkspaceCollectionSyncState>([
  'scanning',
  'importing',
  'chunking',
  'embedding',
  'recovering',
]);

/**
 * Coverage banner for the selected embedding set (workspace-index when
 * `collectionId` is null): "Indexing…" while the indexer is active or chunks
 * are pending, nothing once the set covers every workspace file, or
 * "N of M files indexed" for a partially-covered set.
 *
 * Spec §3 cross-check: `collection_indexing_stats` is dirty-gated, so mid-index
 * it reads STALE/zero (the #1115 gotcha) and `pending_chunk_count` alone would
 * flicker to "complete" while indexing is still running. The LIVE background-sync
 * signal (`useWorkspaceCollectionSyncStatusStore`) is therefore the authoritative
 * "indexing in progress" source — matched to the displayed set via the indexer's
 * managed collection, exactly like `isCollectionIndexingActive` in db-explorer.
 */
export function SearchCoverageBanner({ collectionId, rootIds }: SearchCoverageBannerProps) {
  const { rows } = usePGliteLiveQuery<CollectionStatsRow>({
    cacheKey: makeLiveQueryKey('workspace-search-collection-stats'),
    key: 'id',
    mode: 'incremental',
    query: COLLECTION_STATS_QUERY,
  });

  const { rows: totalRows, loading: totalFilesLoading } = usePGliteLiveQuery<TotalFilesRow>({
    cacheKey: makeLiveQueryKey('workspace-search-total-files', rootIds),
    params: [rootIds],
    query: TOTAL_WORKSPACE_FILES_QUERY,
  });

  const syncState = useWorkspaceCollectionSyncStatusStore((s) => s.state);
  const managedCollectionId = useWorkspaceCollectionSyncStatusStore((s) => s.managedCollectionId);

  const statsRow = useMemo(
    () => resolveEffectiveStatsRow(rows, collectionId),
    [rows, collectionId]
  );

  // The background indexer only ever works its managed collection, so the
  // displayed set is "being indexed" iff the indexer is active on the set this
  // banner shows (explicit id, or the resolved workspace-index row when null).
  const displayedSetId = collectionId ?? statsRow?.id ?? null;
  const indexingActive =
    managedCollectionId !== null &&
    displayedSetId === managedCollectionId &&
    ACTIVE_SYNC_STATES.has(syncState);

  // LIVE signal wins over dirty-gated stats: show a stable, count-free "Indexing…"
  // so the banner never flickers to "complete" while indexing is still running.
  if (indexingActive) {
    return (
      <p className="text-muted-foreground text-xs" role="status">
        Indexing…
      </p>
    );
  }

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

  // Loading guard: before the totals count query resolves, `totalFiles` is 0 and
  // `fileCount >= 0` would falsely read as "fully indexed" (rendering nothing).
  // Suppress rendering until the count has actually loaded so loading is never
  // mistaken for complete.
  if (totalFilesLoading) {
    return null;
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
