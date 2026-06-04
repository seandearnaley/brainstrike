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

  const chunks = coverage.totalChunks.toLocaleString();
  const files = coverage.totalFiles.toLocaleString();
  const pending = coverage.pendingReindexFileCount.toLocaleString();
  const missing = coverage.chunksMissingSourceRange.toLocaleString();

  // Compact, single-line copy so the banner stays a thin status strip under the
  // search bar instead of a multi-line card.
  switch (coverage.status) {
    case 'needs_reindex':
      return `${label} needs re-indexing · ${pending} file${coverage.pendingReindexFileCount === 1 ? '' : 's'} pending`;
    case 'partial_source_ranges':
      return `${missing} chunk${coverage.chunksMissingSourceRange === 1 ? '' : 's'} missing source ranges`;
    case 'fully_indexed':
      return `Fully indexed · ${chunks} chunks / ${files} files`;
    default:
      return null;
  }
}

type CoverageNoticeTone = 'indexing' | 'healthy' | 'warning';

const TONE_ICON: Record<CoverageNoticeTone, typeof CheckCircle2> = {
  indexing: Loader2,
  healthy: CheckCircle2,
  warning: AlertTriangle,
};

const TONE_ICON_CLASS: Record<CoverageNoticeTone, string> = {
  indexing: 'text-sky-500',
  healthy: 'text-emerald-500',
  warning: 'text-amber-500',
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
 * Surfaces collection-level embedding coverage as a thin single-line status:
 * indexing-in-progress, re-index required, partial skips, or healthy state.
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
  const iconClass = `h-3.5 w-3.5 shrink-0 ${TONE_ICON_CLASS[tone]}${
    tone === 'indexing' ? ' animate-spin' : ''
  }`;

  return (
    <div
      className="flex items-center gap-1.5 text-xs"
      data-coverage-status={indexingActive ? 'indexing' : coverage.status}
      data-testid="embedding-coverage-notice"
      role="status"
    >
      <Icon aria-hidden className={iconClass} />
      <span className="truncate text-muted-foreground">{message}</span>
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
    <div className="border-border border-b px-3 py-1.5">
      <EmbeddingCoverageNotice
        coverage={coverage}
        indexingActive={indexingActive}
        {...(activeCollectionName === undefined ? {} : { collectionName: activeCollectionName })}
      />
    </div>
  );
}
