import type { WorkspaceCollectionSyncState } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useNativeWorkspaceSearchDependencies } from '../core/native-workspace-search-context';
import {
  COLLECTION_STATS_QUERY,
  type CollectionStatsRow,
  resolveEffectiveStatsRow,
  toStatsNumber,
} from './collection-stats-query';
import { NativeSearchCoverage } from './native-search-coverage';

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
 * Shared status-strip shell so the coverage banner reads like the Explorer's
 * status rows (RestorationStatus / DirectoryStatus): a quiet rounded muted strip
 * with an optional leading icon.
 */
function CoverageStrip({ children, icon }: { children: ReactNode; icon?: ReactNode }): ReactNode {
  return (
    <div
      className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-muted-foreground text-xs"
      role="status"
    >
      {icon}
      <span className="truncate">{children}</span>
    </div>
  );
}

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
export function SearchCoverageBanner(props: SearchCoverageBannerProps) {
  const native = useNativeWorkspaceSearchDependencies();
  if (native) {
    return <NativeSearchCoverage {...props} native={native} />;
  }
  return <WebSearchCoverageBanner {...props} />;
}

function WebSearchCoverageBanner({ collectionId, rootIds }: SearchCoverageBannerProps) {
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
      <CoverageStrip
        icon={<Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin" />}
      >
        Indexing…
      </CoverageStrip>
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
      <CoverageStrip
        icon={<Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin" />}
      >
        Indexing… ({embeddedChunkCount}/{chunkCount} chunks, {fileCount}/{totalFiles} files)
      </CoverageStrip>
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

  return <CoverageStrip>{`${fileCount} of ${totalFiles} files indexed`}</CoverageStrip>;
}
