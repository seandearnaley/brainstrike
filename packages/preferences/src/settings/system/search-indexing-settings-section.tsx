import { useEmbeddingSetsRepository } from '@brainstrike/db';
import {
  Badge,
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
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useBackgroundIndexingPreferencesStore } from '../../stores/background-indexing-preferences-store';
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

function getStatusBadge(
  state: ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>['state']
) {
  switch (state) {
    case 'scanning':
      return {
        label: 'Scanning root',
        icon: Loader2,
        variant: 'outline' as const,
        iconClassName: 'size-3.5 animate-spin',
      };
    case 'importing':
      return {
        label: 'Importing cache entries',
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
  const setEnabled = useBackgroundIndexingPreferencesStore((state) => state.setEnabled);
  const setManagedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.setManagedCollectionId
  );
  const syncStatus = useWorkspaceCollectionSyncStatusStore((state) => ({
    state: state.state,
    managedCollectionName: state.managedCollectionName,
    currentFilePath: state.currentFilePath,
    queuedFiles: state.queuedFiles,
    processedFiles: state.processedFiles,
    lastError: state.lastError,
    activeRootPath: state.activeRootPath,
  }));

  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    if (!repository) {
      setCollections([]);
      setCollectionsError(null);
      setLoadingCollections(false);
      return;
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
          results
            .map((collection) => ({
              id: collection.id,
              name: collection.name?.trim() || collection.modelId,
              modelKey: collection.modelKey,
              createdAt: collection.createdAt,
            }))
            .sort(compareCollectionsDesc)
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
  }, [repository]);

  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === managedCollectionId) ?? null,
    [collections, managedCollectionId]
  );

  const statusBadge = getStatusBadge(syncStatus.state);
  const StatusIcon = statusBadge.icon;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search & Indexing</CardTitle>
        <CardDescription>
          Enable background indexing for the selected root folder. BrainStrike stores the managed
          collection as a durable cache, so previously indexed roots remain searchable instead of
          being purged when you switch folders.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium text-sm">Background indexing</Label>
            <p className="text-muted-foreground text-sm">
              When enabled, BrainStrike scans the selected root folder, chunks eligible text files,
              and stores embeddings in one managed collection for reuse.
            </p>
          </div>
          <Switch
            aria-label="Background indexing"
            checked={enabled}
            onCheckedChange={(value) => setEnabled(value === true)}
          />
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
              <p className="text-muted-foreground">
                Progress:{' '}
                <span className="font-medium text-foreground">
                  {syncStatus.processedFiles} processed
                  {syncStatus.queuedFiles > 0 ? `, ${syncStatus.queuedFiles} queued` : ''}
                </span>
              </p>
              {syncStatus.currentFilePath ? (
                <p className="text-muted-foreground">
                  Current file:{' '}
                  <span className="font-medium text-foreground">{syncStatus.currentFilePath}</span>
                </p>
              ) : null}
            </div>
          </div>
          {syncStatus.lastError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
              {syncStatus.lastError}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
