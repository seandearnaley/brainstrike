import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import type {
  IndexingActivitySnapshot,
  IndexingActivityStatus,
} from '@brainstrike/preferences/stores/indexing-activity-store';
import { useIndexingActivityStore } from '@brainstrike/preferences/stores/indexing-activity-store';
import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusBarItem,
  type StatusBarItemStatus,
} from '@brainstrike/ui';
import { Activity, CirclePause, Database, Loader2, TriangleAlert } from 'lucide-react';

function toStatusBarStatus(status: IndexingActivityStatus): StatusBarItemStatus {
  if (status === 'error') {
    return 'warning';
  }
  if (status === 'active') {
    return 'loading';
  }
  if (status === 'paused' || status === 'unavailable') {
    return 'disconnected';
  }
  return 'connected';
}

function toStatusValue(snapshot: IndexingActivitySnapshot): string {
  if (snapshot.status === 'unavailable') {
    return 'Unavailable';
  }
  if (snapshot.status === 'paused') {
    return 'Paused';
  }
  if (snapshot.status === 'error') {
    if (snapshot.phase === 'background-indexing') {
      return 'Blocked';
    }
    return 'Issue';
  }
  if (snapshot.status === 'active') {
    if (snapshot.phase === 'manual-backfill') {
      return 'Backfilling';
    }
    if (snapshot.phase === 'background-indexing') {
      return 'Background';
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
    return 'Active';
  }
  return 'Idle';
}

function toStatusIcon(snapshot: IndexingActivitySnapshot) {
  if (snapshot.status === 'error') {
    return TriangleAlert;
  }
  if (snapshot.status === 'paused') {
    return CirclePause;
  }
  if (snapshot.status === 'active') {
    return Activity;
  }
  return Database;
}

function formatCollectionName(snapshot: IndexingActivitySnapshot): string {
  return (
    snapshot.background.managedCollectionName ??
    snapshot.background.managedCollectionId ??
    'None selected'
  );
}

function formatQueueSummary(snapshot: IndexingActivitySnapshot): string {
  if (!snapshot.queue) {
    return 'Queue unavailable';
  }
  return `${snapshot.queue.queued} queued / ${snapshot.queue.running} running / ${snapshot.queue.failed} failed / ${snapshot.queue.succeeded} succeeded`;
}

function formatDatabaseWorkSummary(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'Database QoS unavailable';
  }
  return `${databaseWork.queued.foreground} foreground / ${databaseWork.queued.normal} normal / ${databaseWork.queued.background} background`;
}

function formatDatabaseWorkStats(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'No scheduler stats';
  }
  const foreground = databaseWork.priorityStats.foreground.completed;
  const normal = databaseWork.priorityStats.normal.completed;
  const background = databaseWork.priorityStats.background.completed;
  return `${foreground} foreground / ${normal} normal / ${background} background completed`;
}

function formatDatabaseYieldSummary(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'No yield data';
  }
  if (databaseWork.backgroundYieldCount === 0) {
    return 'No background yields observed';
  }
  const waitMs = Math.round(databaseWork.priorityStats.background.totalWaitMs);
  return `${databaseWork.backgroundYieldCount} background yield${databaseWork.backgroundYieldCount === 1 ? '' : 's'} / ${waitMs}ms background wait`;
}

function formatDatabaseLatencySummary(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'No latency data';
  }
  const foreground = databaseWork.priorityStats.foreground;
  const background = databaseWork.priorityStats.background;
  return `FG p95 ${Math.round(foreground.waitP95Ms)}ms wait / ${Math.round(foreground.serviceP95Ms)}ms service · BG p95 ${Math.round(background.waitP95Ms)}ms wait / ${Math.round(background.serviceP95Ms)}ms service`;
}

function formatDatabaseLabelSummary(snapshot: IndexingActivitySnapshot): string {
  const databaseWork = snapshot.databaseWork;
  if (!databaseWork) {
    return 'No label data';
  }
  const foreground =
    databaseWork.priorityStats.foreground.lastCompletedLabel ??
    databaseWork.priorityStats.foreground.lastStartedLabel ??
    'none';
  const background =
    databaseWork.priorityStats.background.lastCompletedLabel ??
    databaseWork.priorityStats.background.lastStartedLabel ??
    'none';
  return `FG ${foreground} / BG ${background}`;
}

function formatPhase(snapshot: IndexingActivitySnapshot): string {
  if (!snapshot.phase) {
    return snapshot.status === 'idle' ? 'Idle' : 'Unknown';
  }
  return snapshot.phase
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatBackfillProgress(current: number | null, total: number | null): string {
  if (current === null || total === null) {
    return 'Reattaching';
  }
  return `${current}/${total}`;
}

function formatLastUpdated(lastUpdatedAt: number | null): string {
  if (lastUpdatedAt === null) {
    return 'Never';
  }
  return new Date(lastUpdatedAt).toLocaleTimeString();
}

export function IndexingStatusItem() {
  const snapshot = useIndexingActivityStore((state) => state.snapshot);
  const paused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const setPaused = useBackgroundIndexingPreferencesStore((state) => state.setPaused);
  const statusValue = toStatusValue(snapshot);
  const status = toStatusBarStatus(snapshot.status);
  const Icon = toStatusIcon(snapshot);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={`Indexing status: ${statusValue}`}
          className="cursor-default"
          data-testid="indexing-status-trigger"
          type="button"
        >
          <StatusBarItem
            icon={Icon}
            label="Indexing:"
            status={status}
            testId="indexing-status-item"
            value={statusValue}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        className="w-[420px] space-y-3"
        data-testid="indexing-status-popover"
        side="top"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium text-sm">Indexing activity</div>
            <div className="text-muted-foreground text-xs">Phase: {formatPhase(snapshot)}</div>
          </div>
          <Badge variant={snapshot.status === 'error' ? 'destructive' : 'secondary'}>
            {snapshot.status === 'active' ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {statusValue}
          </Badge>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Managed collection</dt>
            <dd className="max-w-[230px] truncate text-right">{formatCollectionName(snapshot)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Queue</dt>
            <dd className="max-w-[260px] text-right">{formatQueueSummary(snapshot)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Worker</dt>
            <dd>{snapshot.worker?.state ?? 'Unknown'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Database QoS</dt>
            <dd className="max-w-[250px] text-right">{formatDatabaseWorkSummary(snapshot)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">DB completed</dt>
            <dd className="max-w-[250px] text-right">{formatDatabaseWorkStats(snapshot)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">DB yields</dt>
            <dd className="max-w-[250px] text-right">{formatDatabaseYieldSummary(snapshot)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">DB latency</dt>
            <dd className="max-w-[250px] text-right">{formatDatabaseLatencySummary(snapshot)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">DB labels</dt>
            <dd className="max-w-[250px] truncate text-right">
              {formatDatabaseLabelSummary(snapshot)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{formatLastUpdated(snapshot.lastUpdatedAt)}</dd>
          </div>
        </dl>

        {snapshot.activeBackfills.length > 0 ? (
          <div className="space-y-2">
            <div className="font-medium text-xs">Active backfills</div>
            <div className="space-y-1">
              {snapshot.activeBackfills.map((backfill) => (
                <div
                  className="flex justify-between gap-3 rounded border px-2 py-1 text-xs"
                  key={backfill.requestId}
                >
                  <span className="truncate">{backfill.embeddingSetId}</span>
                  <span className="text-muted-foreground">
                    {backfill.source === 'manual' ? 'Manual' : 'Background'} ·{' '}
                    {formatBackfillProgress(backfill.current, backfill.total)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {snapshot.background.pauseReasons.length > 0 ? (
          <div className="space-y-1 text-xs">
            <div className="font-medium">Pause reasons</div>
            <div className="text-muted-foreground">
              {snapshot.background.pauseReasons.join(' / ')}
            </div>
          </div>
        ) : null}

        {snapshot.databaseWork?.backgroundWaiting ? (
          <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
            <div className="font-medium">Yielding to foreground database work</div>
            <div className="text-muted-foreground">
              {formatDatabaseWorkSummary(snapshot)} · waiting{' '}
              {Math.round(snapshot.databaseWork.currentBackgroundWaitMs)}ms
            </div>
          </div>
        ) : null}

        {snapshot.lastError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive text-xs">
            {snapshot.lastError}
          </div>
        ) : null}

        {snapshot.background.enabled || snapshot.background.managedCollectionId ? (
          <div className="flex justify-end">
            <Button onClick={() => setPaused(!paused)} size="sm" type="button" variant="outline">
              {paused ? 'Resume background indexing' : 'Pause background indexing'}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
