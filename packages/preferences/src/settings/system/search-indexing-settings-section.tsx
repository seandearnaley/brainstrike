import { useEmbeddingSetsRepository } from '@brainstrike/db';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@brainstrike/ui';
import {
  BACKGROUND_INDEXING_POLICY_OPTIONS,
  type BackgroundIndexingPolicyPreset,
  getBackgroundIndexingPolicyOption,
} from '@brainstrike/utils';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useBackgroundIndexingPreferencesStore } from '../../stores/background-indexing-preferences-store';
import {
  getWorkspaceCollectionSyncCurrentActivity,
  getWorkspaceCollectionSyncMetricRows,
  shouldShowWorkspaceCollectionSyncPauseControl,
} from '../../stores/workspace-collection-sync-status-helpers';
import { useWorkspaceCollectionSyncStatusStore } from '../../stores/workspace-collection-sync-status-store';

interface CollectionOption {
  createdAt: string;
  id: string;
  modelKey: string;
  name: string;
}

function compareCollectionsDesc(left: CollectionOption, right: CollectionOption): number {
  if (right.createdAt > left.createdAt) {
    return 1;
  }
  if (right.createdAt < left.createdAt) {
    return -1;
  }
  return right.id.localeCompare(left.id);
}

function toCollectionOption(collection: {
  createdAt: string;
  id: string;
  modelId: string;
  modelKey: string;
  name?: string | null;
}): CollectionOption {
  return {
    id: collection.id,
    name: collection.name?.trim() || collection.modelId,
    modelKey: collection.modelKey,
    createdAt: collection.createdAt,
  };
}

function getStatusBadge(
  status: Pick<
    ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>,
    'blockedReason' | 'state'
  >
) {
  switch (status.state) {
    case 'blocked':
      return {
        label:
          status.blockedReason === 'missing-provider-key'
            ? 'Waiting for OpenAI key'
            : status.blockedReason === 'browser-turso-chunk-indexing'
              ? 'Web indexing unavailable (browser database engine defect)'
              : 'Blocked',
        icon: AlertTriangle,
        variant: 'destructive' as const,
        iconClassName: 'size-3.5',
      };
    case 'scanning':
      return {
        label: 'Scanning root',
        icon: Loader2,
        variant: 'outline' as const,
        iconClassName: 'size-3.5 animate-spin',
      };
    case 'waiting':
      return {
        label: 'Waiting for restore',
        icon: RefreshCw,
        variant: 'outline' as const,
        iconClassName: 'size-3.5 animate-spin',
      };
    case 'recovering':
      return {
        label: 'Recovering in-flight backfill',
        icon: RefreshCw,
        variant: 'secondary' as const,
        iconClassName: 'size-3.5 animate-spin',
      };
    case 'paused':
      return {
        label: 'Paused',
        icon: AlertTriangle,
        variant: 'outline' as const,
        iconClassName: 'size-3.5',
      };
    case 'importing':
      return {
        label: 'Importing cache files',
        icon: RefreshCw,
        variant: 'outline' as const,
        iconClassName: 'size-3.5 animate-spin',
      };
    case 'chunking':
      return {
        label: 'Chunking cache files',
        icon: RefreshCw,
        variant: 'outline' as const,
        iconClassName: 'size-3.5 animate-spin',
      };
    case 'embedding':
      return {
        label: 'Embedding queued chunks',
        icon: RefreshCw,
        variant: 'secondary' as const,
        iconClassName: 'size-3.5 animate-spin',
      };
    case 'error':
      return {
        label: 'Blocked',
        icon: AlertTriangle,
        variant: 'destructive' as const,
        iconClassName: 'size-3.5',
      };
    case 'idle':
      return {
        label: 'Ready',
        icon: CheckCircle2,
        variant: 'secondary' as const,
        iconClassName: 'size-3.5',
      };
    default:
      return {
        label: 'Disabled',
        icon: AlertTriangle,
        variant: 'outline' as const,
        iconClassName: 'size-3.5',
      };
  }
}

export function SearchIndexingSettingsSection() {
  const repository = useEmbeddingSetsRepository();
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const indexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.indexingPolicyPreset
  );
  const setEnabled = useBackgroundIndexingPreferencesStore((state) => state.setEnabled);
  const setIndexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.setIndexingPolicyPreset
  );
  const setManagedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.setManagedCollectionId
  );
  const paused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const setPaused = useBackgroundIndexingPreferencesStore((state) => state.setPaused);
  const syncStatus = useWorkspaceCollectionSyncStatusStore((state) => ({
    state: state.state,
    backfillRequestId: state.backfillRequestId,
    blockedReason: state.blockedReason,
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
  }));

  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [collectionsRefreshToken, setCollectionsRefreshToken] = useState(0);

  useEffect(() => {
    let disposed = false;

    if (!repository) {
      setCollections([]);
      setCollectionsError(null);
      setLoadingCollections(false);
      return () => {
        disposed = true;
      };
    }

    setLoadingCollections(true);
    setCollectionsError(null);

    void repository
      .findAll()
      .then((results) => {
        if (disposed) {
          return;
        }
        setCollections(
          results.map((collection) => toCollectionOption(collection)).sort(compareCollectionsDesc)
        );
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        setCollectionsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (disposed) {
          return;
        }
        setLoadingCollections(false);
      });

    return () => {
      disposed = true;
    };
  }, [collectionsRefreshToken, repository]);

  useEffect(() => {
    const handleCollectionRefresh = (): void => {
      setCollectionsRefreshToken((currentToken) => currentToken + 1);
    };

    window.addEventListener('brainstrike:embedding-set-updated', handleCollectionRefresh);
    window.addEventListener('brainstrike:queue-drained', handleCollectionRefresh);
    return () => {
      window.removeEventListener('brainstrike:embedding-set-updated', handleCollectionRefresh);
      window.removeEventListener('brainstrike:queue-drained', handleCollectionRefresh);
    };
  }, []);

  useEffect(() => {
    if (!(managedCollectionId && !loadingCollections && !collectionsError)) {
      return;
    }
    if (collections.some((collection) => collection.id === managedCollectionId)) {
      return;
    }
    let disposed = false;
    void repository
      ?.getById(managedCollectionId)
      .then((collection) => {
        if (disposed) {
          return;
        }
        if (!collection) {
          setManagedCollectionId(null);
          return;
        }
        setCollections((currentCollections) => {
          if (currentCollections.some((candidate) => candidate.id === collection.id)) {
            return currentCollections;
          }
          return [...currentCollections, toCollectionOption(collection)].sort(
            compareCollectionsDesc
          );
        });
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        setCollectionsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
    };
  }, [
    collections,
    collectionsError,
    loadingCollections,
    managedCollectionId,
    repository,
    setManagedCollectionId,
  ]);

  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === managedCollectionId) ?? null,
    [collections, managedCollectionId]
  );
  const selectedPolicy = useMemo(
    () => getBackgroundIndexingPolicyOption(indexingPolicyPreset),
    [indexingPolicyPreset]
  );

  const statusBadge = getStatusBadge(syncStatus);
  const StatusIcon = statusBadge.icon;
  const metricRows = getWorkspaceCollectionSyncMetricRows(syncStatus);
  const currentActivity = getWorkspaceCollectionSyncCurrentActivity(syncStatus);
  const showPauseControl =
    enabled &&
    (paused ||
      managedCollectionId !== null ||
      shouldShowWorkspaceCollectionSyncPauseControl(syncStatus.state));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace Index</CardTitle>
        <CardDescription>
          Keep your workspace folders searchable through BrainStrike's system-managed workspace
          index collection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium text-sm">Workspace Index</Label>
            <p className="text-muted-foreground text-sm">
              When enabled, BrainStrike scans your workspace folders, chunks eligible text files,
              and stores embeddings in the protected workspace index.
            </p>
          </div>
          <Switch
            aria-label="Workspace Index"
            checked={enabled}
            onCheckedChange={(value) => setEnabled(value === true)}
          />
        </div>

        <div className="space-y-2">
          <Label className="font-medium text-sm" htmlFor="managed-cache-policy">
            Indexing policy
          </Label>
          <Select
            onValueChange={(value) =>
              setIndexingPolicyPreset(value as BackgroundIndexingPolicyPreset)
            }
            value={indexingPolicyPreset}
          >
            <SelectTrigger aria-label="Indexing policy" id="managed-cache-policy">
              <SelectValue placeholder="Select an indexing policy" />
            </SelectTrigger>
            <SelectContent>
              {BACKGROUND_INDEXING_POLICY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                  {option.recommended ? ' (Recommended)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-sm">{selectedPolicy.description}</p>
        </div>

        <div className="space-y-2">
          <Label className="font-medium text-sm" htmlFor="managed-cache-collection">
            Managed collection
          </Label>
          <Select
            onValueChange={(value) => setManagedCollectionId(value === '__none__' ? null : value)}
            value={managedCollectionId ?? '__none__'}
          >
            <SelectTrigger id="managed-cache-collection">
              <SelectValue placeholder="Select a managed collection" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No managed collection</SelectItem>
              {collections.map((collection) => (
                <SelectItem key={collection.id} value={collection.id}>
                  {collection.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-sm">
            Manual DB imports are blocked for the managed collection because BrainStrike owns its
            cache lifecycle. Unmanaged collections keep the existing manual import/export flow.
          </p>
          {loadingCollections ? (
            <p className="text-muted-foreground text-xs">Loading collections…</p>
          ) : null}
          {collectionsError ? <p className="text-destructive text-xs">{collectionsError}</p> : null}
          {selectedCollection ? (
            <p className="text-muted-foreground text-xs">
              Current managed collection:{' '}
              <span className="font-medium">{selectedCollection.name}</span> (
              {selectedCollection.modelKey})
            </p>
          ) : null}
        </div>

        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-start gap-3">
            <Badge className="flex items-center gap-1" variant={statusBadge.variant}>
              <StatusIcon className={statusBadge.iconClassName} />
              {statusBadge.label}
            </Badge>
            <div className="flex-1 space-y-1 text-sm">
              <p className="text-muted-foreground">
                Root:{' '}
                <span className="font-medium text-foreground">
                  {syncStatus.activeRootPath ?? 'None selected'}
                </span>
              </p>
              <p className="text-muted-foreground">
                Collection:{' '}
                <span className="font-medium text-foreground">
                  {syncStatus.managedCollectionName ?? selectedCollection?.name ?? 'None selected'}
                </span>
              </p>
              {metricRows.map((row) => (
                <p className="text-muted-foreground" key={row.label}>
                  {row.label}: <span className="font-medium text-foreground">{row.value}</span>
                </p>
              ))}
              {currentActivity ? (
                <p className="text-muted-foreground">
                  {currentActivity.label}:{' '}
                  <span className="font-medium text-foreground">{currentActivity.value}</span>
                </p>
              ) : null}
            </div>
          </div>
          {syncStatus.lastError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
              {syncStatus.lastError}
            </div>
          ) : null}
          {showPauseControl ? (
            <div className="flex justify-end">
              <Button onClick={() => setPaused(!paused)} size="sm" type="button" variant="outline">
                {paused ? 'Resume workspace index' : 'Pause workspace index'}
              </Button>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
