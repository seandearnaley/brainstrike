import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  getWorkspaceCollectionSyncCurrentActivity,
  getWorkspaceCollectionSyncMetricRows,
  shouldShowWorkspaceCollectionSyncPauseControl,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-helpers';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { useEmbeddingSetsRepository } from '@brainstrike/db/react';
import { parseEmbeddingProviderModelKey } from '@brainstrike/indexing-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { NativeLocalSelection } from '@brainstrike/indexing-contract/indexer-producer';
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
import { onEmbeddingSetUpdated, onQueueDrained } from '@brainstrike/utils/browser-events';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface CollectionOption {
  createdAt: string;
  dimensions: number;
  id: string;
  modelId: string;
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
  dimensions: number;
  id: string;
  modelId: string;
  modelKey: string;
  name?: string | null;
}): CollectionOption {
  return {
    createdAt: collection.createdAt,
    dimensions: collection.dimensions,
    id: collection.id,
    modelId: collection.modelId,
    modelKey: collection.modelKey,
    name: collection.name?.trim() || collection.modelId,
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
        icon: AlertTriangle,
        iconClassName: 'size-3.5',
        label:
          status.blockedReason === 'missing-provider-key' ? 'Waiting for OpenAI key' : 'Blocked',
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
        label: 'No root selected',
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

function NativeIndexControls({
  nativeIndex,
  selectedCollection,
}: {
  readonly nativeIndex: Pick<IndexSearchCapability, 'rebuild'>;
  readonly selectedCollection: CollectionOption | null;
}) {
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const rebuild = async (): Promise<void> => {
    if (rebuilding) {
      return;
    }
    setRebuilding(true);
    setRebuildError(null);
    try {
      await nativeIndex.rebuild();
    } catch (error) {
      setRebuildError(error instanceof Error ? error.message : String(error));
    } finally {
      setRebuilding(false);
    }
  };
  const nativeIndexMode = useBackgroundIndexingPreferencesStore((state) => state.nativeIndexMode);
  const nativeLocalSelection = useBackgroundIndexingPreferencesStore(
    (state) => state.nativeLocalSelection
  );
  const setNativeIndexMode = useBackgroundIndexingPreferencesStore(
    (state) => state.setNativeIndexMode
  );
  const setNativeLocalSelection = useBackgroundIndexingPreferencesStore(
    (state) => state.setNativeLocalSelection
  );
  const localPlans = selectedCollection ? getNativeLocalPlans(selectedCollection) : [];
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="native-index-mode">Search mode</Label>
        <Select
          {...(nativeIndexMode === null ? {} : { value: nativeIndexMode })}
          onValueChange={(value) => {
            if (value === 'TEXT' || value === 'VECTOR') {
              setNativeIndexMode(value);
            }
          }}
        >
          <SelectTrigger aria-label="Search mode" id="native-index-mode">
            <SelectValue placeholder="Choose a search mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="TEXT">Text search</SelectItem>
            <SelectItem value="VECTOR">Text and semantic search</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-sm">
          Text search indexes files without running an embedding model. Semantic search also uses
          your selected collection's local model.
        </p>
      </div>
      {nativeIndexMode === 'VECTOR' ? (
        <div className="space-y-2">
          <Label htmlFor="native-inference-plan">Local model execution</Label>
          <Select
            {...(nativeLocalSelection ? { value: JSON.stringify(nativeLocalSelection) } : {})}
            onValueChange={(value) => {
              const selection = localPlans.find((plan) => JSON.stringify(plan.selection) === value);
              if (!selection) {
                throw new Error('Selected local model execution is unavailable.');
              }
              setNativeLocalSelection(selection.selection);
            }}
          >
            <SelectTrigger aria-label="Local model execution" id="native-inference-plan">
              <SelectValue placeholder="Choose local model execution" />
            </SelectTrigger>
            <SelectContent>
              {localPlans.map((plan) => (
                <SelectItem key={plan.label} value={JSON.stringify(plan.selection)}>
                  {plan.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {localPlans.length === 0 ? (
            <p className="text-muted-foreground text-sm" role="status">
              The selected collection has no supported local execution plan. Choose a supported
              local collection.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-2">
        <Button
          disabled={rebuilding}
          onClick={() => {
            void rebuild();
          }}
          type="button"
          variant="outline"
        >
          {rebuilding ? 'Rebuilding search index…' : 'Rebuild search index'}
        </Button>
        <p className="text-muted-foreground text-sm">
          Recreates the search index from your files and collection. Chats, application data,
          collections, and model choices are preserved.
        </p>
        {rebuildError ? (
          <p className="text-destructive text-sm" role="alert">
            {rebuildError}
          </p>
        ) : null}
      </div>
    </>
  );
}

export function SearchIndexingSettingsSection({
  nativeIndex,
}: {
  readonly nativeIndex?: Pick<IndexSearchCapability, 'rebuild'>;
} = {}) {
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

    const unsubscribeEmbeddingSetUpdated = onEmbeddingSetUpdated(handleCollectionRefresh);
    const unsubscribeQueueDrained = onQueueDrained(handleCollectionRefresh);
    return () => {
      unsubscribeEmbeddingSetUpdated();
      unsubscribeQueueDrained();
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
        {nativeIndex ? (
          <NativeIndexControls nativeIndex={nativeIndex} selectedCollection={selectedCollection} />
        ) : null}
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

function getNativeLocalPlans(collection: CollectionOption): readonly {
  readonly label: string;
  readonly selection: NativeLocalSelection;
}[] {
  const provider = parseEmbeddingProviderModelKey(collection.modelKey)?.provider;
  if ((provider !== 'local' && provider !== 'transformers') || collection.dimensions !== 384) {
    return [];
  }
  const base = { dimensions: collection.dimensions, modelId: collection.modelId };
  if (collection.modelId === 'onnx-community/all-MiniLM-L6-v2-ONNX') {
    const revision = 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f';
    return [
      { label: 'WebGPU · FP16', selection: { ...base, device: 'webgpu', dtype: 'fp16', revision } },
      { label: 'WASM · FP32', selection: { ...base, device: 'wasm', dtype: 'fp32', revision } },
    ];
  }
  if (collection.modelId === 'Xenova/all-MiniLM-L6-v2') {
    const revision = '751bff37182d3f1213fa05d7196b954e230abad9';
    return [
      { label: 'WASM · Q8', selection: { ...base, device: 'wasm', dtype: 'q8', revision } },
      { label: 'WASM · FP32', selection: { ...base, device: 'wasm', dtype: 'fp32', revision } },
    ];
  }
  return [];
}
