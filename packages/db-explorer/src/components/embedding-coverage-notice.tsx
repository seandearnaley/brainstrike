import type { WorkspaceCollectionSyncState } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
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

interface NoticeCopy {
  /** Tooltip text. For actionable states this carries remediation guidance the
   * compact line omits, so the title adds value instead of duplicating it. */
  detail: string;
  /** Compact, single-line visible text. */
  message: string;
}

function buildNoticeCopy(
  coverage: CollectionEmbeddingCoverageSnapshot,
  indexingActive: boolean,
  collectionName?: string
): NoticeCopy | null {
  const label = collectionName ? `"${collectionName}"` : 'This collection';

  if (indexingActive) {
    // Intentionally count-free so the text never changes during indexing.
    const message = `${label} is indexing…`;
    return { detail: message, message };
  }

  const chunks = coverage.totalChunks.toLocaleString();
  const files = coverage.totalFiles.toLocaleString();
  const pending = coverage.pendingReindexFileCount.toLocaleString();
  const missing = coverage.chunksMissingSourceRange.toLocaleString();
  const filePlural = coverage.pendingReindexFileCount === 1 ? '' : 's';
  const chunkPlural = coverage.chunksMissingSourceRange === 1 ? '' : 's';

  // Compact, single-line copy keeps the banner a thin status strip under the
  // search bar; the richer `detail` is surfaced on hover via the title so the
  // remediation guidance is recoverable without bloating the strip.
  switch (coverage.status) {
    case 'needs_reindex':
      return {
        detail: `${label} needs re-indexing after the source line-range update — re-import or run indexing so retrieval can cite exact line ranges. ${pending} file${filePlural} still have unprocessed chunks.`,
        message: `${label} needs re-indexing · ${pending} file${filePlural} pending`,
      };
    case 'partial_source_ranges':
      return {
        detail: `${missing} chunk${chunkPlural} missing source ranges. Semantic search may skip those hits until they are re-chunked.`,
        message: `${missing} chunk${chunkPlural} missing source ranges`,
      };
    case 'fully_indexed': {
      const message = `Fully indexed · ${chunks} chunk${coverage.totalChunks === 1 ? '' : 's'} / ${files} file${coverage.totalFiles === 1 ? '' : 's'}`;
      return { detail: message, message };
    }
    default:
      return null;
  }
}

type CoverageNoticeTone = 'indexing' | 'healthy' | 'warning';

const TONE_ICON: Record<CoverageNoticeTone, typeof CheckCircle2> = {
  healthy: CheckCircle2,
  indexing: Loader2,
  warning: AlertTriangle,
};

const TONE_ICON_CLASS: Record<CoverageNoticeTone, string> = {
  healthy: 'text-success',
  indexing: 'text-info',
  warning: 'text-warning',
};

// Actionable warnings keep toned TEXT (not just a tiny colored icon) so they
// stand out from the muted healthy/indexing states and don't rely on color
// alone (WCAG). Healthy/indexing are non-actionable, so they stay calm.
const TONE_TEXT_CLASS: Record<CoverageNoticeTone, string> = {
  healthy: 'text-muted-foreground',
  indexing: 'text-muted-foreground',
  warning: 'text-warning',
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
  const copy = buildNoticeCopy(coverage, indexingActive, collectionName);
  if (!copy) {
    return null;
  }
  const { message, detail } = copy;

  const tone = resolveTone(coverage.status, indexingActive);
  const Icon = TONE_ICON[tone];
  const iconClass = `h-3.5 w-3.5 shrink-0 ${TONE_ICON_CLASS[tone]}${
    tone === 'indexing' ? ' animate-spin' : ''
  }`;

  // Actionable (warning) states carry remediation the user must act on. Native
  // `title` tooltips are hover-only — unreachable by keyboard and touch — so the
  // guidance is rendered VISIBLY (wraps, never truncated) for warnings. The
  // non-actionable healthy/indexing states stay a compact, truncating strip with
  // the full text recoverable via `title` for the rare overflow case.
  const isActionable = tone === 'warning';

  return (
    <div
      className={`flex gap-1.5 text-xs ${isActionable ? 'items-start' : 'items-center'}`}
      data-coverage-status={indexingActive ? 'indexing' : coverage.status}
      data-testid="embedding-coverage-notice"
      role="status"
    >
      <Icon aria-hidden className={iconClass} />
      {isActionable ? (
        <span className={`min-w-0 ${TONE_TEXT_CLASS[tone]}`}>{detail}</span>
      ) : (
        <span className={`min-w-0 truncate ${TONE_TEXT_CLASS[tone]}`} title={detail}>
          {message}
        </span>
      )}
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
