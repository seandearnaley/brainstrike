import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  getWorkspaceCollectionSyncCurrentActivity,
  getWorkspaceCollectionSyncMetricRows,
  shouldShowWorkspaceCollectionSyncPauseControl,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-helpers';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusBarItem,
} from '@brainstrike/ui';
import { getBackgroundIndexingPolicyOption } from '@brainstrike/utils';
import { Database, Loader2, TriangleAlert } from 'lucide-react';

function truncateMiddle(value: string, maxLength = 48): string {
  if (value.length <= maxLength) {
    return value;
  }
  const segmentLength = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, segmentLength)}…${value.slice(-segmentLength)}`;
}

const selectCollectionSyncStatus = (
  state: ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>
) => ({
  state: state.state,
  backfillRequestId: state.backfillRequestId,
  managedCollectionName: state.managedCollectionName,
  currentFilePath: state.currentFilePath,
  lastError: state.lastError,
  pauseReasons: state.pauseReasons,
  activeRootPath: state.activeRootPath,
  scanSummary: state.scanSummary,
  importProgress: state.importProgress,
  chunkingProgress: state.chunkingProgress,
  embeddingProgress: state.embeddingProgress,
  queueProgress: state.queueProgress,
});

function getStatusItemValue(
  state: ReturnType<typeof selectCollectionSyncStatus>['state'],
  enabled: boolean
):
  | 'Blocked'
  | 'Chunking'
  | 'Embedding'
  | 'Importing'
  | 'Paused'
  | 'Ready'
  | 'Recovering'
  | 'Scanning'
  | 'Waiting'
  | 'Off' {
  if (state === 'blocked' || state === 'error') {
    return 'Blocked';
  }
  if (state === 'waiting') {
    return 'Waiting';
  }
  if (state === 'recovering') {
    return 'Recovering';
  }
  if (state === 'paused') {
    return 'Paused';
  }
  if (state === 'scanning') {
    return 'Scanning';
  }
  if (state === 'chunking') {
    return 'Chunking';
  }
  if (state === 'embedding') {
    return 'Embedding';
  }
  if (state === 'importing') {
    return 'Importing';
  }
  return enabled ? 'Ready' : 'Off';
}

function getStatusItemState(
  state: ReturnType<typeof selectCollectionSyncStatus>['state'],
  enabled: boolean
) {
  const isBusy =
    state === 'waiting' ||
    state === 'recovering' ||
    state === 'scanning' ||
    state === 'importing' ||
    state === 'chunking' ||
    state === 'embedding';
  return {
    isBusy,
    status:
      state === 'blocked' || state === 'error'
        ? 'warning'
        : state === 'paused'
          ? 'disconnected'
          : isBusy
            ? 'loading'
            : enabled
              ? 'connected'
              : 'disconnected',
    value: getStatusItemValue(state, enabled),
  } as const;
}

function isStatusItemVisible(args: {
  enabled: boolean;
  managedCollectionId: string | null;
  syncStatus: ReturnType<typeof selectCollectionSyncStatus>;
}): boolean {
  return (
    args.enabled ||
    Boolean(args.managedCollectionId) ||
    args.syncStatus.state !== 'disabled' ||
    Boolean(args.syncStatus.lastError)
  );
}

export function CollectionSyncStatusItem() {
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

  if (!isStatusItemVisible({ enabled, managedCollectionId, syncStatus })) {
    return null;
  }

  const label = syncStatus.managedCollectionName ?? 'Index cache';
  const { isBusy, status, value } = getStatusItemState(syncStatus.state, enabled);
  const selectedPolicy = getBackgroundIndexingPolicyOption(indexingPolicyPreset);
  const metricRows = getWorkspaceCollectionSyncMetricRows(syncStatus);
  const currentActivity = getWorkspaceCollectionSyncCurrentActivity(syncStatus);
  const showPauseControl = shouldShowWorkspaceCollectionSyncPauseControl(syncStatus.state);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="cursor-default"
          data-testid="collection-sync-status-trigger"
          type="button"
        >
          <StatusBarItem
            icon={
              syncStatus.state === 'blocked' || syncStatus.state === 'error'
                ? TriangleAlert
                : Database
            }
            label={`Cache: ${label}`}
            status={status}
            testId="collection-sync-status-item"
            value={value}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-96 space-y-3" side="top">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium text-sm">Workspace Index cache</div>
            <Badge
              variant={
                syncStatus.state === 'blocked' || syncStatus.state === 'error'
                  ? 'destructive'
                  : enabled
                    ? 'secondary'
                    : 'outline'
              }
            >
              {isBusy ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
              {value}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">
            Managed collection: {syncStatus.managedCollectionName ?? 'None selected'}
          </p>
          <p className="text-muted-foreground text-xs">Policy: {selectedPolicy.label}</p>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Root</dt>
            <dd className="max-w-[240px] truncate text-right">
              {syncStatus.activeRootPath
                ? truncateMiddle(syncStatus.activeRootPath)
                : 'None selected'}
            </dd>
          </div>
          {metricRows.map((row) => (
            <div className="flex justify-between gap-3" key={row.label}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="max-w-[240px] text-right">{row.value}</dd>
            </div>
          ))}
          {currentActivity ? (
            <div className="space-y-1">
              <dt className="text-muted-foreground">{currentActivity.label}</dt>
              <dd className="break-all text-xs">{truncateMiddle(currentActivity.value, 72)}</dd>
            </div>
          ) : null}
        </dl>

        {syncStatus.lastError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive text-xs">
            {syncStatus.lastError}
          </div>
        ) : null}
        {showPauseControl ? (
          <div className="flex justify-end">
            <Button
              aria-label="Workspace Index"
              aria-pressed={!paused}
              onClick={() => setPaused(!paused)}
              size="sm"
              type="button"
              variant="outline"
            >
              {paused ? 'Resume workspace index' : 'Pause workspace index'}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
