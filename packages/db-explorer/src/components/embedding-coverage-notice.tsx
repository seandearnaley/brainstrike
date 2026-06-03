import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
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

interface IndexingActiveInput {
  collectionId: string | null;
  indexingTargetId: string | null;
  isEmbeddingActive: boolean;
  isImporting: boolean;
}

/**
 * Decide whether the displayed collection is the one currently being indexed.
 *
 * The DB cannot distinguish a file that is mid-chunking (transient) from one that
 * predates the line-range migration (genuinely stale) — both have
 * `chunks_processed_at IS NULL`. The only reliable disambiguator is whether the
 * importer/embedding worker is actively running for this collection, which lives
 * in the shared vector-status store.
 */
export function isCollectionIndexingActive({
  collectionId,
  indexingTargetId,
  isEmbeddingActive,
  isImporting,
}: IndexingActiveInput): boolean {
  if (!collectionId) {
    return false;
  }
  if (!(isImporting || isEmbeddingActive)) {
    return false;
  }
  // When the target is known, only the matching collection shows the indexing
  // note; a null target means "indexing is happening but unattributed", so we
  // fall back to showing it rather than re-surfacing the false re-index alarm.
  return indexingTargetId === null || indexingTargetId === collectionId;
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
  const isImporting = useVectorStatusUIStore((s) => s.isImporting);
  const isEmbeddingActive = useVectorStatusUIStore((s) => s.isEmbeddingActive);
  const indexingTargetId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);

  const indexingActive = isCollectionIndexingActive({
    collectionId: activeCollectionId,
    indexingTargetId,
    isEmbeddingActive,
    isImporting,
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
