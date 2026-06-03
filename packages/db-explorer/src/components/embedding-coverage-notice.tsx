import type { WorkspaceCollectionSyncState } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import {
  type CollectionEmbeddingCoverageSnapshot,
  useCollectionEmbeddingCoverage,
} from '../hooks/use-collection-embedding-coverage';

export interface EmbeddingCoverageNoticeProps {
  collectionName?: string;
  coverage: CollectionEmbeddingCoverageSnapshot;
  /**
   * True while the displayed collection is actively importing/indexing. When set,
   * the notice replaces the (churn-prone) re-index/partial alarms with a single
   * stable "indexing" line so the banner does not flicker or shift layout as the
   * per-file pending count ticks down.
   */
  indexingActive?: boolean;
}

/**
 * Background-indexer states that mean "actively doing work on the managed
 * collection right now". `idle`/`waiting`/`paused`/`disabled`/`error` are not
 * active, so a stale collection still shows its real re-index guidance.
 */
const ACTIVE_SYNC_STATES = new Set<WorkspaceCollectionSyncState>([
  'scanning',
  'importing',
  'chunking',
  'embedding',
  'recovering',
]);

interface IndexingActiveInput {
  /** The collection currently displayed in the browser. */
  collectionId: string | null;
  /** The collection the background indexer manages, if any. */
  managedCollectionId: string | null;
  /** Live background-indexer sync state. */
  syncState: WorkspaceCollectionSyncState;
}

/**
 * Decide whether the DISPLAYED collection is the one actively being indexed.
 *
 * The DB cannot distinguish a file that is mid-chunking (transient) from one that
 * predates the line-range migration (genuinely stale) — both have
 * `chunks_processed_at IS NULL`. The disambiguator must be PER COLLECTION and must
 * RELIABLY CLEAR when work finishes.
 *
 * We use ONLY the background indexer's managed collection + its live sync state.
 * The sync state machine settles to `idle`/`waiting` via `setIdleStatus` when a
 * job completes, so the note clears on its own. We deliberately do NOT key off the
 * shared `activeBackfill` store signal: the visible vector-status panel "recovers"
 * a backfill into that store and does not always clear it after a background job
 * finishes, which left the banner spinning indefinitely (the overnight bug).
 */
export function isCollectionIndexingActive({
  collectionId,
  managedCollectionId,
  syncState,
}: IndexingActiveInput): boolean {
  if (!collectionId) {
    return false;
  }
  // The background indexer only ever works its managed collection.
  return managedCollectionId === collectionId && ACTIVE_SYNC_STATES.has(syncState);
}

function buildNoticeMessage(
  coverage: CollectionEmbeddingCoverageSnapshot,
  indexingActive: boolean,
  collectionName?: string
): string | null {
  const label = collectionName ? `"${collectionName}"` : 'This collection';

  if (indexingActive) {
    // Intentionally count-free so the text never changes during indexing.
    return `${label} is indexing…`;
  }

  switch (coverage.status) {
    case 'needs_reindex':
      return `${label} needs re-indexing after the source line-range update. ${coverage.pendingReindexFileCount.toLocaleString()} file${coverage.pendingReindexFileCount === 1 ? '' : 's'} still have unprocessed chunks. Re-import or run indexing so retrieval can cite exact line ranges.`;
    case 'partial_source_ranges':
      return `${label} has ${coverage.chunksMissingSourceRange.toLocaleString()} chunk${coverage.chunksMissingSourceRange === 1 ? '' : 's'} missing source line metadata. Semantic search may skip those hits until they are re-chunked.`;
    case 'fully_indexed':
      return `${label} is fully indexed with line-aware chunk metadata (${coverage.totalChunks.toLocaleString()} chunk${coverage.totalChunks === 1 ? '' : 's'} across ${coverage.totalFiles.toLocaleString()} file${coverage.totalFiles === 1 ? '' : 's'}).`;
    default:
      return null;
  }
}

type CoverageNoticeTone = 'indexing' | 'healthy' | 'warning';

const TONE_CLASS: Record<CoverageNoticeTone, string> = {
  indexing:
    'rounded-md border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-sky-900 text-xs dark:text-sky-100',
  healthy:
    'rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-emerald-900 text-xs dark:text-emerald-100',
  warning:
    'rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-950 text-xs dark:text-amber-50',
};

const TONE_ICON: Record<CoverageNoticeTone, typeof CheckCircle2> = {
  indexing: Loader2,
  healthy: CheckCircle2,
  warning: AlertTriangle,
};

function resolveTone(
  status: CollectionEmbeddingCoverageSnapshot['status'],
  indexingActive: boolean
): CoverageNoticeTone {
  if (indexingActive) {
    return 'indexing';
  }
  return status === 'fully_indexed' ? 'healthy' : 'warning';
}

/**
 * Surfaces collection-level embedding coverage: indexing-in-progress, re-index
 * required, partial skips, or healthy state.
 */
export function EmbeddingCoverageNotice({
  collectionName,
  coverage,
  indexingActive = false,
}: EmbeddingCoverageNoticeProps) {
  const message = buildNoticeMessage(coverage, indexingActive, collectionName);
  if (!message) {
    return null;
  }

  const tone = resolveTone(coverage.status, indexingActive);
  const Icon = TONE_ICON[tone];

  return (
    <div
      className={TONE_CLASS[tone]}
      data-coverage-status={indexingActive ? 'indexing' : coverage.status}
      data-testid="embedding-coverage-notice"
      role="status"
    >
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden
          className={
            tone === 'indexing' ? 'mt-0.5 h-4 w-4 shrink-0 animate-spin' : 'mt-0.5 h-4 w-4 shrink-0'
          }
        />
        <p>{message}</p>
      </div>
    </div>
  );
}

export interface CollectionEmbeddingCoverageBannerProps {
  activeCollectionId: string | null;
  activeCollectionName?: string;
}

/** Live-query wrapper for {@link EmbeddingCoverageNotice} in collection browser layouts. */
export function CollectionEmbeddingCoverageBanner({
  activeCollectionId,
  activeCollectionName,
}: CollectionEmbeddingCoverageBannerProps) {
  const { snapshot: coverage } = useCollectionEmbeddingCoverage(activeCollectionId);
  const syncState = useWorkspaceCollectionSyncStatusStore((s) => s.state);
  const managedCollectionId = useWorkspaceCollectionSyncStatusStore((s) => s.managedCollectionId);

  const indexingActive = isCollectionIndexingActive({
    collectionId: activeCollectionId,
    managedCollectionId,
    syncState,
  });

  // While indexing is active we still render (with a stable note) even before
  // the first file lands, so the user gets immediate feedback instead of nothing.
  if (!activeCollectionId || (coverage.status === 'idle' && !indexingActive)) {
    return null;
  }

  return (
    <div className="border-border border-b px-3 py-2">
      <EmbeddingCoverageNotice
        coverage={coverage}
        indexingActive={indexingActive}
        {...(activeCollectionName === undefined ? {} : { collectionName: activeCollectionName })}
      />
    </div>
  );
}
