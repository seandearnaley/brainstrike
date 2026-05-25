import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  type CollectionEmbeddingCoverageSnapshot,
  useCollectionEmbeddingCoverage,
} from '../hooks/use-collection-embedding-coverage';

export interface EmbeddingCoverageNoticeProps {
  collectionName?: string;
  coverage: CollectionEmbeddingCoverageSnapshot;
}

function buildNoticeMessage(
  coverage: CollectionEmbeddingCoverageSnapshot,
  collectionName?: string
): string | null {
  const label = collectionName ? `"${collectionName}"` : 'This collection';

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

/**
 * Surfaces collection-level embedding coverage: re-index required, partial skips, or healthy state.
 */
export function EmbeddingCoverageNotice({
  collectionName,
  coverage,
}: EmbeddingCoverageNoticeProps) {
  const message = buildNoticeMessage(coverage, collectionName);
  if (!message) {
    return null;
  }

  const isHealthy = coverage.status === 'fully_indexed';
  const Icon = isHealthy ? CheckCircle2 : AlertTriangle;

  return (
    <div
      className={
        isHealthy
          ? 'rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-emerald-900 text-xs dark:text-emerald-100'
          : 'rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-950 text-xs dark:text-amber-50'
      }
      data-coverage-status={coverage.status}
      data-testid="embedding-coverage-notice"
      role="status"
    >
      <div className="flex items-start gap-2">
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
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
  if (!activeCollectionId || coverage.status === 'idle') {
    return null;
  }

  return (
    <div className="border-border border-b px-3 py-2">
      <EmbeddingCoverageNotice
        coverage={coverage}
        {...(activeCollectionName === undefined ? {} : { collectionName: activeCollectionName })}
      />
    </div>
  );
}
