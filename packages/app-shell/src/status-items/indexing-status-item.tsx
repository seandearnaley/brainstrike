import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import type {
  IndexingActivitySnapshot,
  IndexingManagedCollectionStatsState,
} from '@brainstrike/app-state/stores/indexing-activity-store';
import { useIndexingActivityStore } from '@brainstrike/app-state/stores/indexing-activity-store';
import {
  getWorkspaceCollectionSyncCurrentActivity,
  getWorkspaceCollectionSyncMetricRows,
  shouldShowWorkspaceCollectionSyncPauseControl,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-helpers';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
} from '@brainstrike/ui';
import { getBackgroundIndexingPolicyOption } from '@brainstrike/utils';
import { CirclePause, Database, Loader2, TriangleAlert } from 'lucide-react';
import { useId } from 'react';

const EMPTY_METRIC_VALUE = '—';

const selectCollectionSyncStatus = (
  state: ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>
) => ({
  activeRootPath: state.activeRootPath,
  chunkingProgress: state.chunkingProgress,
  currentFilePath: state.currentFilePath,
  embeddingProgress: state.embeddingProgress,
  importProgress: state.importProgress,
  lastError: state.lastError,
  managedCollectionId: state.managedCollectionId,
  managedCollectionName: state.managedCollectionName,
  pauseReasons: state.pauseReasons,
  queueProgress: state.queueProgress,
  scanSummary: state.scanSummary,
  state: state.state,
  unindexableFileCount: state.unindexableFileCount,
});

type CollectionSyncStatus = ReturnType<typeof selectCollectionSyncStatus>;

interface DisplayStatus {
  readonly busy: boolean;
  readonly toneClassName: string;
  readonly value: string;
}

function formatSyncState(state: CollectionSyncStatus['state']): string | null {
  switch (state) {
    case 'waiting':
      return 'Waiting';
    case 'recovering':
      return 'Recovering';
    case 'scanning':
      return 'Scanning';
    case 'importing':
      return 'Importing';
    case 'chunking':
      return 'Chunking';
    case 'embedding':
      return 'Embedding';
    default:
      return null;
  }
}

function formatSnapshotActivity(snapshot: IndexingActivitySnapshot): string {
  if (snapshot.phase === 'manual-backfill') {
    return 'Backfilling';
  }
  if (snapshot.phase === 'importing') {
    return 'Importing';
  }
  if (snapshot.phase === 'chunking') {
    return 'Chunking';
  }
  if (snapshot.phase === 'embedding') {
    return 'Embedding';
  }
  if (snapshot.phase === 'background-indexing') {
    return 'Background';
  }
  return 'Active';
}

function getDisplayStatus(args: {
  readonly enabled: boolean;
  readonly managedStats: IndexingManagedCollectionStatsState;
  readonly paused: boolean;
  readonly snapshot: IndexingActivitySnapshot;
  readonly syncStatus: CollectionSyncStatus;
}): DisplayStatus {
  const { enabled, managedStats, paused, snapshot, syncStatus } = args;
  if (
    syncStatus.state === 'blocked' ||
    syncStatus.state === 'error' ||
    (snapshot.status === 'error' && snapshot.phase === 'background-indexing')
  ) {
    return {
      busy: false,
      toneClassName: 'text-amber-800 dark:text-amber-300',
      value: 'Blocked',
    };
  }
  if (snapshot.status === 'error' || managedStats.status === 'error') {
    return {
      busy: false,
      toneClassName: 'text-amber-800 dark:text-amber-300',
      value: 'Issue',
    };
  }
  if (paused || syncStatus.state === 'paused' || snapshot.status === 'paused') {
    return { busy: false, toneClassName: 'text-red-800 dark:text-red-300', value: 'Paused' };
  }
  if (snapshot.activeBackfills.some((backfill) => backfill.source === 'manual')) {
    return {
      busy: true,
      toneClassName: 'text-sky-800 dark:text-sky-300',
      value: 'Backfilling',
    };
  }
  const syncValue = formatSyncState(syncStatus.state);
  if (syncValue) {
    return { busy: true, toneClassName: 'text-sky-800 dark:text-sky-300', value: syncValue };
  }
  if (snapshot.status === 'active') {
    return {
      busy: true,
      toneClassName: 'text-sky-800 dark:text-sky-300',
      value: formatSnapshotActivity(snapshot),
    };
  }
  // Missing setup is neither broken nor fully synced. Name the missing input
  // instead of claiming a root is absent when only the collection is missing.
  if (syncStatus.state === 'unconfigured') {
    return {
      busy: false,
      toneClassName: 'text-muted-foreground',
      value: syncStatus.activeRootPath ? 'No collection selected' : 'No root selected',
    };
  }
  if (snapshot.status === 'unavailable') {
    return { busy: false, toneClassName: 'text-muted-foreground', value: 'Unavailable' };
  }
  if (!enabled) {
    return { busy: false, toneClassName: 'text-muted-foreground', value: 'Off' };
  }
  return {
    busy: false,
    toneClassName: 'text-emerald-800 dark:text-emerald-300',
    value: 'Ready',
  };
}

function truncateMiddle(value: string, maxLength = 64): string {
  if (value.length <= maxLength) {
    return value;
  }
  const segmentLength = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, segmentLength)}…${value.slice(-segmentLength)}`;
}

function formatCount(value: number | null): string {
  return value === null ? EMPTY_METRIC_VALUE : value.toLocaleString();
}

function getVisibleStats(managedStats: IndexingManagedCollectionStatsState) {
  return managedStats.stats;
}

function getCoveragePercent(managedStats: IndexingManagedCollectionStatsState): number | null {
  const stats = getVisibleStats(managedStats);
  if (!stats) {
    return null;
  }
  if (stats.chunkCount === 0) {
    return 0;
  }
  return Math.min(100, Math.round((stats.embeddedChunkCount / stats.chunkCount) * 100));
}

function getStatsStatusText(managedStats: IndexingManagedCollectionStatsState): string {
  switch (managedStats.status) {
    case 'loading':
      return 'Statistics are loading';
    case 'pending':
      return 'Statistics are preparing';
    case 'error':
      return 'Statistics need attention';
    case 'ready':
      return managedStats.stats?.dirty ? 'Statistics refresh pending' : 'Statistics are current';
    case 'unavailable':
      return 'Statistics unavailable';
  }
}

function formatCoverageStatus(
  managedStats: IndexingManagedCollectionStatsState,
  coveragePercent: number | null
): string {
  if (coveragePercent === null) {
    return getStatsStatusText(managedStats);
  }
  if (managedStats.status === 'error') {
    return `${coveragePercent}% · stale`;
  }
  if (managedStats.stats?.dirty) {
    return `${coveragePercent}% · updating`;
  }
  return `${coveragePercent}%`;
}

function formatDurableQueue(snapshot: IndexingActivitySnapshot): string {
  if (!snapshot.queue) {
    return 'Queue unavailable';
  }
  return `${snapshot.queue.queued.toLocaleString()} queued · ${snapshot.queue.running.toLocaleString()} running · ${snapshot.queue.failed.toLocaleString()} failed`;
}

function formatWorkspaceQueue(syncStatus: CollectionSyncStatus): string {
  const queue = syncStatus.queueProgress;
  if (!queue) {
    return 'No workspace queue activity';
  }
  return `${queue.processed.toLocaleString()} done · ${queue.pending.toLocaleString()} pending · ${queue.failed.toLocaleString()} failed`;
}

function formatBackfillSummary(snapshot: IndexingActivitySnapshot): string {
  const firstBackfill = snapshot.activeBackfills[0];
  if (!firstBackfill) {
    return 'No active backfill';
  }
  const progress =
    firstBackfill.current === null || firstBackfill.total === null
      ? 'Reattaching'
      : `${firstBackfill.current.toLocaleString()}/${firstBackfill.total.toLocaleString()}`;
  const source = firstBackfill.source === 'manual' ? 'Manual' : 'Background';
  const extraCount = snapshot.activeBackfills.length - 1;
  return `${source} · ${progress}${extraCount > 0 ? ` · +${extraCount} more` : ''}`;
}

function formatDatabaseQueueSummary(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'Database QoS unavailable';
  }
  return `${databaseWork.queued.foreground} foreground · ${databaseWork.queued.normal} normal · ${databaseWork.queued.background} background`;
}

function formatDatabaseCompleted(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'No scheduler history';
  }
  return `${databaseWork.priorityStats.foreground.completed} foreground · ${databaseWork.priorityStats.normal.completed} normal · ${databaseWork.priorityStats.background.completed} background`;
}

function formatDatabaseYields(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'No yield data';
  }
  return `${databaseWork.backgroundYieldCount} yield${databaseWork.backgroundYieldCount === 1 ? '' : 's'} · ${Math.round(databaseWork.priorityStats.background.totalWaitMs)}ms wait`;
}

function formatDatabaseLatency(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'No latency data';
  }
  const foreground = databaseWork.priorityStats.foreground;
  const background = databaseWork.priorityStats.background;
  return `FG ${Math.round(foreground.waitP95Ms)}ms / ${Math.round(foreground.serviceP95Ms)}ms · BG ${Math.round(background.waitP95Ms)}ms / ${Math.round(background.serviceP95Ms)}ms`;
}

function formatDatabaseLabels(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'No recent labels';
  }
  const foreground =
    databaseWork.priorityStats.foreground.lastCompletedLabel ??
    databaseWork.priorityStats.foreground.lastStartedLabel ??
    'none';
  const background =
    databaseWork.priorityStats.background.lastCompletedLabel ??
    databaseWork.priorityStats.background.lastStartedLabel ??
    'none';
  return `FG ${foreground} · BG ${background}`;
}

function formatLastRefreshed(managedStats: IndexingManagedCollectionStatsState): string {
  const timestamp = managedStats.stats?.lastRefreshedAt;
  if (!timestamp) {
    return 'Never';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid timestamp';
  }
  return date.toLocaleTimeString();
}

interface MetricTileProps {
  readonly label: string;
  readonly testId: string;
  readonly value: number | null;
}

function MetricTile({ label, testId, value }: MetricTileProps) {
  return (
    <div className="flex h-16 flex-col justify-between rounded-md border bg-muted/30 px-2.5 py-2">
      <div className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="truncate font-semibold text-base tabular-nums" data-testid={testId}>
        {formatCount(value)}
      </div>
    </div>
  );
}

interface SummaryRowProps {
  readonly label: string;
  readonly value: string;
}

function SummaryRow({ label, value }: SummaryRowProps) {
  return (
    <div className="grid h-6 grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-right tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

function StatusIcon({ displayStatus }: { readonly displayStatus: DisplayStatus }) {
  if (displayStatus.value === 'Blocked' || displayStatus.value === 'Issue') {
    return <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />;
  }
  if (displayStatus.value === 'Paused') {
    return <CirclePause aria-hidden="true" className="size-3 shrink-0" />;
  }
  if (displayStatus.busy) {
    return (
      <Loader2
        aria-hidden="true"
        className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
      />
    );
  }
  return <Database aria-hidden="true" className="size-3 shrink-0" />;
}

interface IndexingActivityRegionProps {
  readonly currentActivity: { readonly label: string; readonly value: string } | null;
  readonly databaseWork: IndexingActivitySnapshot['databaseWork'];
  readonly error: string | null;
}

function IndexingActivityRegion({
  currentActivity,
  databaseWork,
  error,
}: IndexingActivityRegionProps) {
  if (error) {
    return (
      <div
        className="flex h-16 flex-col justify-center rounded-md border bg-muted/20 px-3 py-2"
        data-testid="indexing-activity-region"
      >
        <div className="text-destructive text-xs" title={error}>
          <div className="font-medium">Indexing needs attention</div>
          <div className="line-clamp-2">{error}</div>
        </div>
      </div>
    );
  }

  if (currentActivity) {
    return (
      <div
        className="flex h-16 flex-col justify-center rounded-md border bg-muted/20 px-3 py-2"
        data-testid="indexing-activity-region"
      >
        <div className="min-w-0 text-xs">
          <div className="font-medium">{currentActivity.label}</div>
          <div className="truncate text-muted-foreground" title={currentActivity.value}>
            {truncateMiddle(currentActivity.value)}
          </div>
        </div>
      </div>
    );
  }

  if (databaseWork?.backgroundWaiting) {
    return (
      <div
        className="flex h-16 flex-col justify-center rounded-md border bg-muted/20 px-3 py-2"
        data-testid="indexing-activity-region"
      >
        <div className="text-xs">
          <div className="font-medium">Yielding to foreground database work</div>
          <div className="truncate text-muted-foreground tabular-nums">
            Waiting {Math.round(databaseWork.currentBackgroundWaitMs)}ms
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-16 flex-col justify-center rounded-md border bg-muted/20 px-3 py-2"
      data-testid="indexing-activity-region"
    >
      <div className="text-muted-foreground text-xs">No active indexing work</div>
    </div>
  );
}

export function IndexingStatusItem() {
  const popoverTitleId = useId();
  const snapshot = useIndexingActivityStore((state) => state.snapshot);
  const managedStats = useIndexingActivityStore((state) => state.managedCollectionStats);
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const indexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.indexingPolicyPreset
  );
  const paused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const setPaused = useBackgroundIndexingPreferencesStore((state) => state.setPaused);
  const syncStatus = useWorkspaceCollectionSyncStatusStore(selectCollectionSyncStatus);
  const displayStatus = getDisplayStatus({ enabled, managedStats, paused, snapshot, syncStatus });
  const selectedPolicy = getBackgroundIndexingPolicyOption(indexingPolicyPreset);
  const metricRows = getWorkspaceCollectionSyncMetricRows(syncStatus);
  const currentActivity = getWorkspaceCollectionSyncCurrentActivity(syncStatus);
  const stats = getVisibleStats(managedStats);
  const coveragePercent = getCoveragePercent(managedStats);
  const combinedError = syncStatus.lastError ?? managedStats.error ?? snapshot.lastError;
  const collectionName =
    syncStatus.managedCollectionName ??
    snapshot.background.managedCollectionName ??
    managedStats.collectionId ??
    managedCollectionId ??
    'Not configured';
  const showPauseControl =
    shouldShowWorkspaceCollectionSyncPauseControl(syncStatus.state) ||
    shouldShowWorkspaceCollectionSyncPauseControl(snapshot.background.state);

  return (
    <Popover>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="indexing-status-announcement"
        role="status"
      >
        Workspace Index status: {displayStatus.value}
      </span>
      <PopoverTrigger asChild>
        <button
          aria-label={`Workspace Index status: ${displayStatus.value}. Open indexing activity`}
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-sm px-1.5 text-left transition-[background-color,color] duration-150 hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset md:w-56 md:px-2"
          data-testid="indexing-status-trigger"
          type="button"
        >
          <span
            aria-hidden="true"
            className={`flex w-full min-w-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap md:justify-start ${displayStatus.toneClassName}`}
            data-testid="indexing-status-item"
          >
            <StatusIcon displayStatus={displayStatus} />
            <span className="hidden min-w-0 flex-1 truncate whitespace-nowrap md:block">
              Workspace Index
            </span>
            <span
              className="hidden w-20 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-right font-medium tabular-nums md:block"
              data-testid="indexing-status-value"
            >
              {displayStatus.value}
            </span>
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        aria-labelledby={popoverTitleId}
        className="h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(32rem,calc(100vw-1rem))] overflow-y-auto p-0"
        collisionPadding={8}
        data-testid="indexing-status-popover"
        side="top"
        sideOffset={8}
      >
        <div className="border-b bg-muted/20 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-sm" id={popoverTitleId}>
                Workspace Index
              </div>
              <div className="truncate text-muted-foreground text-xs" title={collectionName}>
                {collectionName}
              </div>
            </div>
            <Badge
              className="min-w-20 shrink-0 justify-center tabular-nums"
              variant={displayStatus.value === 'Blocked' ? 'destructive' : 'secondary'}
            >
              {displayStatus.busy ? (
                <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
              ) : null}
              {displayStatus.value}
            </Badge>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Policy: {selectedPolicy.label}
          </div>
        </div>

        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricTile
              label="Files"
              testId="managed-stat-files"
              value={stats?.fileCount ?? null}
            />
            <MetricTile
              label="Chunks"
              testId="managed-stat-chunks"
              value={stats?.chunkCount ?? null}
            />
            <MetricTile
              label="Embedded"
              testId="managed-stat-embedded"
              value={stats?.embeddedChunkCount ?? null}
            />
            <MetricTile
              label="Pending"
              testId="managed-stat-pending"
              value={stats?.pendingChunkCount ?? null}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex min-h-4 items-center justify-between gap-3 text-[11px]">
              <span className="text-muted-foreground">Embedding coverage</span>
              <span
                className="w-32 truncate text-right tabular-nums"
                title={getStatsStatusText(managedStats)}
              >
                {formatCoverageStatus(managedStats, coveragePercent)}
              </span>
            </div>
            <Progress
              aria-label="Workspace Index embedding coverage"
              className="h-1.5"
              value={coveragePercent ?? undefined}
            />
          </div>

          <dl className="rounded-md border px-3 py-2">
            <SummaryRow label="Embedding queue" value={formatDurableQueue(snapshot)} />
            <SummaryRow label="Workspace queue" value={formatWorkspaceQueue(syncStatus)} />
            <SummaryRow label="Active backfill" value={formatBackfillSummary(snapshot)} />
          </dl>

          <IndexingActivityRegion
            currentActivity={currentActivity}
            databaseWork={snapshot.databaseWork}
            error={combinedError}
          />

          <Accordion collapsible type="single">
            <AccordionItem className="rounded-md border px-3" value="diagnostics">
              <AccordionTrigger className="py-2.5 hover:no-underline">
                Worker and database diagnostics
              </AccordionTrigger>
              <AccordionContent className="space-y-2 pb-3">
                <dl className="space-y-1">
                  <SummaryRow label="Worker state" value={snapshot.worker?.state ?? 'Unknown'} />
                  <SummaryRow label="Database QoS" value={formatDatabaseQueueSummary(snapshot)} />
                  <SummaryRow label="DB completed" value={formatDatabaseCompleted(snapshot)} />
                  <SummaryRow label="DB yields" value={formatDatabaseYields(snapshot)} />
                  <SummaryRow label="DB p95 wait / run" value={formatDatabaseLatency(snapshot)} />
                  <SummaryRow label="Recent DB work" value={formatDatabaseLabels(snapshot)} />
                  <SummaryRow label="Stats refreshed" value={formatLastRefreshed(managedStats)} />
                  <SummaryRow label="Root" value={syncStatus.activeRootPath ?? 'None selected'} />
                  {metricRows.map((row) => (
                    <SummaryRow key={row.label} label={row.label} value={row.value} />
                  ))}
                </dl>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <div className="flex h-11 justify-end border-t pt-3" data-testid="indexing-action-region">
            {showPauseControl ? (
              <Button onClick={() => setPaused(!paused)} size="sm" type="button" variant="outline">
                {paused ? 'Resume workspace index' : 'Pause workspace index'}
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
