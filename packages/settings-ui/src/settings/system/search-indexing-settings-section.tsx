import {
  useAvailableModels,
  useAvailableProviders,
} from '@brainstrike/app-state/hooks/use-available-embedding-models';
import { useLocalRuntimeEmbeddingModelCatalog } from '@brainstrike/app-state/hooks/use-local-runtime-embedding-model-catalog';
import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import {
  getWorkspaceCollectionSyncCurrentActivity,
  getWorkspaceCollectionSyncMetricRows,
  shouldShowWorkspaceCollectionSyncPauseControl,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-helpers';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { findProviderDefinition } from '@brainstrike/assistant-contract/provider-registry';
import { useEmbeddingSetsRepository } from '@brainstrike/db/react';
import {
  type CatalogEmbeddingModel,
  decodeCatalogEmbeddingModel,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
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
  ModelPicker,
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
import {
  dispatchEmbeddingSetUpdated,
  onEmbeddingSetUpdated,
  onQueueDrained,
} from '@brainstrike/utils/browser-events';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface CollectionOption {
  createdAt: string;
  dimensions: number;
  id: string;
  modelId: string;
  modelKey: string;
  name: string;
}

interface CollectionModel {
  dimensions: number;
  modelId: string;
  modelKey: string;
  name: string;
}

function compareCollectionsDesc(
  left: Pick<CollectionOption, 'createdAt' | 'id'>,
  right: Pick<CollectionOption, 'createdAt' | 'id'>
): number {
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
    'blockedReason' | 'state' | 'lastError'
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
  const models = useModelRegistryStore((state) => state.models);
  const catalog = useMemo(
    () => readLocalCatalogModel(models, selectedCollection),
    [models, selectedCollection]
  );
  const localPlans = selectedCollection
    ? getNativeLocalPlans(selectedCollection, nativeLocalSelection, catalog.model)
    : [];
  const selectedPlan = localPlans.find(
    ({ selection }) =>
      selection.device === nativeLocalSelection?.device &&
      selection.dtype === nativeLocalSelection.dtype &&
      selection.modelId === nativeLocalSelection.modelId &&
      selection.dimensions === nativeLocalSelection.dimensions &&
      selection.revision === nativeLocalSelection.revision
  );
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="native-index-mode">Search mode</Label>
        <Select
          {...{ value: nativeIndexMode ?? '' }}
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
          your selected collection's embedding model and provider.
        </p>
      </div>
      {nativeIndexMode === 'VECTOR' && localPlans.length > 0 ? (
        <div className="space-y-2">
          <Label htmlFor="native-inference-plan">Local model execution</Label>
          <Select
            {...{ value: selectedPlan ? JSON.stringify(selectedPlan.selection) : '' }}
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
          {localPlans.length > 0 ? (
            <p className="text-muted-foreground text-sm" role="status">
              {catalog.model?.execution
                ? 'Choose WebGPU on devices that have it; WASM runs this model without WebGPU, more slowly. Each choice keeps its own vectors.'
                : 'Choose the execution format provided by your model. Unavailable formats report an error; indexing never substitutes another model or execution device.'}
            </p>
          ) : null}
        </div>
      ) : null}
      {catalog.error ? (
        <p className="text-destructive text-sm" role="alert">
          {catalog.error}
        </p>
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

async function findOrCreateNativeCollection(
  repository: NonNullable<ReturnType<typeof useEmbeddingSetsRepository>>,
  model: CollectionModel,
  currentId: string | null
) {
  const matches = (await repository.findAll()).filter(
    (collection) =>
      collection.modelKey === model.modelKey &&
      collection.modelId === model.modelId &&
      collection.dimensions === model.dimensions &&
      collection.distance === 'cosine'
  );
  const existing =
    matches.find((collection) => collection.id === currentId) ??
    matches.sort(compareCollectionsDesc)[0];
  if (existing) {
    return existing;
  }
  const created = await repository.getOrCreateSet(
    model.modelKey,
    model.modelId,
    model.dimensions,
    'cosine',
    { name: `Workspace Index (${model.name})` }
  );
  dispatchEmbeddingSetUpdated({ id: created.id, reason: 'created' });
  return created;
}

function NativeCollectionSetup({
  repository,
  onCreated,
}: {
  readonly repository: ReturnType<typeof useEmbeddingSetsRepository>;
  readonly onCreated: (collection: CollectionOption) => void;
}) {
  const [setupModelKey, setSetupModelKey] = useState('');
  const registryError = useEnsureModelRegistry();
  const models = useModelRegistryStore((state) => state.models);
  const providers = useModelRegistryStore((state) => state.providers);
  const runtime = useLocalRuntimeEmbeddingModelCatalog({
    maxVerificationModels: 8,
    verifyEmbeddingDimensions: true,
  });
  const availableModels = useAvailableModels(models, runtime.catalog);
  const availableProviders = useAvailableProviders(providers, runtime.catalog);
  const recommended = availableModels.find((model) =>
    isRecommendedEmbeddingModel(model.providerId, model.modelId)
  );
  const selectedModel = availableModels.find((model) => model.id === setupModelKey);
  const dimensions = selectedModel?.capabilities.defaultDimension;
  const setupModel: CollectionModel | null =
    selectedModel &&
    typeof dimensions === 'number' &&
    Number.isInteger(dimensions) &&
    dimensions > 0
      ? {
          dimensions,
          modelId: selectedModel.modelId,
          modelKey: selectedModel.id,
          name: selectedModel.name,
        }
      : null;
  const setupPending = useRef(false);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const setupWorkspaceIndex = async (): Promise<void> => {
    if (!(repository && setupModel) || setupPending.current) {
      return;
    }
    const previousCollectionId =
      useBackgroundIndexingPreferencesStore.getState().managedCollectionId;
    let superseded = false;
    const unsubscribe = useBackgroundIndexingPreferencesStore.subscribe((next, previous) => {
      if (
        next.managedCollectionId !== previous.managedCollectionId ||
        next.nativeLocalSelection !== previous.nativeLocalSelection ||
        next.nativeIndexMode !== previous.nativeIndexMode
      ) {
        superseded = true;
      }
    });
    setupPending.current = true;
    setCreatingCollection(true);
    setSetupError(null);
    try {
      const collection = await findOrCreateNativeCollection(
        repository,
        setupModel,
        previousCollectionId
      );
      onCreated(toCollectionOption(collection));
      if (superseded) {
        return;
      }
      unsubscribe();
      if (collection.id !== previousCollectionId) {
        useBackgroundIndexingPreferencesStore.getState().setNativeLocalSelection(null);
        useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId(collection.id);
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      unsubscribe();
      setupPending.current = false;
      setCreatingCollection(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm">
        Choose an embedding model from your existing collection providers. Selecting a different
        model creates or selects its own collection and preserves your existing collection.
      </p>
      {recommended ? (
        <p className="text-muted-foreground text-sm" role="note">
          <span className="font-medium text-foreground">Recommended: {recommended.name}.</span>{' '}
          {recommended.description}
        </p>
      ) : null}
      <Label htmlFor="workspace-index-model">Embedding model</Label>
      <ModelPicker
        disabled={creatingCollection}
        mode="single"
        models={availableModels}
        modelType="embedding"
        onChange={(value) => {
          if (typeof value === 'string') {
            setSetupModelKey(value);
          }
        }}
        providers={availableProviders}
        renderTrigger={() => (
          <Button
            aria-label="Embedding model"
            disabled={creatingCollection}
            id="workspace-index-model"
            role="combobox"
            type="button"
            variant="outline"
          >
            {selectedModel?.name ?? 'Choose an embedding model'}
          </Button>
        )}
        value={setupModelKey}
      />
      {selectedModel && !setupModel ? (
        <p role="alert">
          This model has no verified embedding dimensions. Configure it in Models before creating a
          collection.
        </p>
      ) : null}
      {registryError || runtime.error ? <p role="alert">{registryError ?? runtime.error}</p> : null}
      <Button
        disabled={!(repository && setupModel) || creatingCollection}
        onClick={() => void setupWorkspaceIndex()}
        type="button"
      >
        {creatingCollection ? 'Setting up Workspace Index…' : 'Use embedding model'}
      </Button>
      {setupError ? (
        <p className="text-destructive text-sm" role="alert">
          {setupError}
        </p>
      ) : null}
    </div>
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
          <NativeCollectionSetup
            onCreated={(collection) => {
              setCollections((current) => [
                collection,
                ...current.filter((entry) => entry.id !== collection.id),
              ]);
            }}
            repository={repository}
          />
        ) : null}
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
            onValueChange={(value) => {
              const nextId = value === '__none__' ? null : value;
              if (nativeIndex && nextId !== managedCollectionId) {
                useBackgroundIndexingPreferencesStore.getState().setNativeLocalSelection(null);
              }
              setManagedCollectionId(nextId);
            }}
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

/** The static catalog's recommended flag (`default`) for an embedding model. */
function isRecommendedEmbeddingModel(providerId: string, modelId: string): boolean {
  return (
    findProviderDefinition(providerId)?.models.some(
      (definition) =>
        definition.id === modelId && definition.type === 'embedding' && definition.default === true
    ) ?? false
  );
}

/** The selected local collection's catalog row; a malformed row is reported, never guessed. */
function readLocalCatalogModel(
  models: readonly DbModel[],
  collection: CollectionOption | null
): { readonly error: string | null; readonly model: CatalogEmbeddingModel | null } {
  const provider = collection
    ? parseEmbeddingProviderModelKey(collection.modelKey)?.provider
    : undefined;
  const row =
    collection && (provider === 'local' || provider === 'transformers')
      ? models.find(
          (model) => model.id === collection.modelId && model.capabilities.type === 'embedding'
        )
      : undefined;
  if (!row) {
    return { error: null, model: null };
  }
  try {
    return { error: null, model: decodeCatalogEmbeddingModel(row) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), model: null };
  }
}

const EXECUTION_LABELS: Record<'webgpu' | 'wasm', string> = { wasm: 'WASM', webgpu: 'WebGPU' };

function getNativeLocalPlans(
  collection: CollectionOption,
  current: NativeLocalSelection | null,
  catalog: CatalogEmbeddingModel | null
): readonly {
  readonly label: string;
  readonly selection: NativeLocalSelection;
}[] {
  const provider = parseEmbeddingProviderModelKey(collection.modelKey)?.provider;
  if (provider !== 'local' && provider !== 'transformers') {
    return [];
  }
  // BST-1993: a catalog row that states its execution offers exactly those plans, at its pin.
  if (catalog?.execution) {
    return (['webgpu', 'wasm'] as const).flatMap((device) => {
      const dtype = catalog.execution?.[device];
      return dtype
        ? [
            {
              label: `${EXECUTION_LABELS[device]} · ${dtype.toUpperCase()}`,
              selection: {
                device,
                dimensions: collection.dimensions,
                dtype,
                modelId: collection.modelId,
                ...(catalog.revision === undefined ? {} : { revision: catalog.revision }),
              },
            },
          ]
        : [];
    });
  }
  const choices: readonly {
    device: 'webgpu' | 'wasm';
    dtype: NativeLocalSelection['dtype'];
    label: string;
  }[] = [
    { device: 'webgpu', dtype: 'fp16', label: 'WebGPU · FP16' },
    { device: 'webgpu', dtype: 'fp32', label: 'WebGPU · FP32' },
    { device: 'webgpu', dtype: 'q4', label: 'WebGPU · Q4' },
    { device: 'webgpu', dtype: 'q8', label: 'WebGPU · Q8' },
    { device: 'wasm', dtype: 'fp32', label: 'WASM · FP32' },
    { device: 'wasm', dtype: 'q4', label: 'WASM · Q4' },
    { device: 'wasm', dtype: 'q8', label: 'WASM · Q8' },
  ];
  return choices.map(({ device, dtype, label }) => ({
    label,
    selection: {
      device,
      dimensions: collection.dimensions,
      dtype,
      modelId: collection.modelId,
      ...(current?.modelId === collection.modelId &&
      current.dimensions === collection.dimensions &&
      current.revision
        ? { revision: current.revision }
        : {}),
    },
  }));
}
