import {
  getWorkspaceCollectionSyncCurrentActivity,
  getWorkspaceCollectionSyncMetricRows,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-helpers';
import {
  useWorkspaceCollectionSyncStatusStore,
  type WorkspaceCollectionSyncBlockedReason,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import type { IndexConfig } from '@brainstrike/assistant-contract/index-config';
import { Badge, Button, Card, CardContent } from '@brainstrike/ui';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';

/** Each typed reason a person must act on, named; the Record keeps the list exhaustive. */
const BLOCKED_REASON_LABELS: Readonly<Record<WorkspaceCollectionSyncBlockedReason, string>> = {
  'missing-provider-key': 'Waiting for a provider key',
};

function getStatusBadge(
  status: Pick<
    ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>,
    'blockedReason' | 'state' | 'lastError'
  >
) {
  switch (status.state) {
    case 'blocked':
      return {
        icon: AlertTriangle,
        iconClassName: 'size-3.5',
        label:
          status.blockedReason === null ? 'Blocked' : BLOCKED_REASON_LABELS[status.blockedReason],
        variant: 'destructive' as const,
      };
    case 'scanning':
      return {
        icon: Loader2,
        iconClassName: 'size-3.5 animate-spin',
        label: 'Scanning root',
        variant: 'outline' as const,
      };
    case 'waiting':
      return {
        icon: RefreshCw,
        iconClassName: 'size-3.5 animate-spin',
        label: 'Waiting for restore',
        variant: 'outline' as const,
      };
    case 'recovering':
      return {
        icon: RefreshCw,
        iconClassName: 'size-3.5 animate-spin',
        label: 'Recovering in-flight backfill',
        variant: 'secondary' as const,
      };
    case 'paused':
      return {
        icon: AlertTriangle,
        iconClassName: 'size-3.5',
        label: 'Paused',
        variant: 'outline' as const,
      };
    case 'importing':
      return {
        icon: RefreshCw,
        iconClassName: 'size-3.5 animate-spin',
        label: 'Importing cache files',
        variant: 'outline' as const,
      };
    case 'chunking':
      return {
        icon: RefreshCw,
        iconClassName: 'size-3.5 animate-spin',
        label: 'Chunking cache files',
        variant: 'outline' as const,
      };
    case 'embedding':
      return {
        icon: RefreshCw,
        iconClassName: 'size-3.5 animate-spin',
        label: 'Embedding queued chunks',
        variant: 'secondary' as const,
      };
    case 'error':
      return {
        icon: AlertTriangle,
        iconClassName: 'size-3.5',
        label: 'Blocked',
        variant: 'destructive' as const,
      };
    case 'idle':
      return {
        icon: CheckCircle2,
        iconClassName: 'size-3.5',
        label: 'Ready',
        variant: 'secondary' as const,
      };
    case 'unconfigured':
      // BST-1335: no root selected yet — setup incomplete, not an error.
      return {
        icon: AlertTriangle,
        iconClassName: 'size-3.5',
        label: status.lastError ? 'Setup required' : 'No root selected',
        variant: 'outline' as const,
      };
    default:
      return {
        icon: AlertTriangle,
        iconClassName: 'size-3.5',
        label: 'Disabled',
        variant: 'outline' as const,
      };
  }
}

export function SearchIndexStatus({
  mode,
  onTogglePause,
  paused,
}: {
  readonly mode: IndexConfig['mode'];
  readonly onTogglePause: (() => void) | null;
  readonly paused: boolean;
}) {
  const syncStatus = useWorkspaceCollectionSyncStatusStore((state) => ({
    activeRootPath: state.activeRootPath,
    backfillRequestId: state.backfillRequestId,
    blockedReason: state.blockedReason,
    chunkingProgress: state.chunkingProgress,
    currentFilePath: state.currentFilePath,
    embeddingProgress: state.embeddingProgress,
    importProgress: state.importProgress,
    lastError: state.lastError,
    managedCollectionName: state.managedCollectionName,
    pauseReasons: state.pauseReasons,
    queueProgress: state.queueProgress,
    scanSummary: state.scanSummary,
    state: state.state,
    unindexableFileCount: state.unindexableFileCount,
  }));
  const badge = getStatusBadge(syncStatus);
  const StatusIcon = badge.icon;
  const activity = getWorkspaceCollectionSyncCurrentActivity(syncStatus);
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge className="flex items-center gap-1" variant={badge.variant}>
            <StatusIcon className={badge.iconClassName} />
            {badge.label}
          </Badge>
          {mode !== 'off' && onTogglePause ? (
            <Button onClick={onTogglePause} size="sm" type="button" variant="outline">
              {paused ? 'Resume indexing' : 'Pause indexing'}
            </Button>
          ) : null}
        </div>
        <dl className="grid gap-1 text-sm">
          {getWorkspaceCollectionSyncMetricRows(syncStatus).map((row) => (
            <div className="flex justify-between gap-4" key={row.label}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="font-medium tabular-nums">{row.value}</dd>
            </div>
          ))}
          {activity ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{activity.label}</dt>
              <dd className="truncate font-medium">{activity.value}</dd>
            </div>
          ) : null}
        </dl>
        {syncStatus.lastError ? (
          <p
            className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm"
            role="alert"
          >
            {syncStatus.lastError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
