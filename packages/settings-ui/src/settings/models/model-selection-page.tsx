import {
  useEnsureModelRegistry,
  useModelRegistrySource,
} from '@brainstrike/app-state/hooks/use-model-registry';
import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { decodeCatalogEmbeddingModel } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { Button, cn, useToast } from '@brainstrike/ui';
import { RefreshCw } from 'lucide-react';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ModelCatalog } from './model-catalog';
import { getModelRuntimeServices } from './model-runtime-services';
import { useDownloadedModelsRead } from './use-downloaded-models-read';
import { type ModelBulkChange, useModelBulkToggle } from './use-model-bulk-toggle';
import { DATABASE_NOT_READY, useModelToggle } from './use-model-toggle';

const logger = createLogger('ModelSelectionPage');

type ToastFn = ReturnType<typeof useToast>['toast'];

interface DownloadDeps {
  setDownloading: (modelId: string, isDownloading: boolean) => void;
  setDownloadProgress: (modelId: string, progress: number) => void;
  toast: ToastFn;
}

async function downloadEmbeddingModel(
  model: DbModel,
  { setDownloadProgress, setDownloading, toast }: DownloadDeps
): Promise<void> {
  const { downloadEmbeddingModel: runEmbeddingModelDownload } = getModelRuntimeServices();
  setDownloading(model.id, true);
  try {
    // The catalog row is the one owner of the model's pins and per-device dtype (BST-1993).
    const catalogModel = decodeCatalogEmbeddingModel({
      capabilities: model.capabilities,
      id: model.id,
      parameters: model.parameters,
    });
    toast({
      description: `Starting download for ${model.name}...`,
      title: 'Download Started',
    });
    await runEmbeddingModelDownload(catalogModel);
    setDownloadProgress(model.id, 100);
    toast({
      description: `${model.name} downloaded successfully!`,
      title: 'Download Complete',
    });
  } catch (err) {
    logger.error('Failed to download embedding model', err);
    toast({
      description: `Failed to download ${model.name}: ${(err as Error).message}`,
      title: 'Download Failed',
      variant: 'destructive',
    });
  } finally {
    setDownloading(model.id, false);
  }
}

/**
 * Only ON-DEVICE EMBEDDING models are downloadable. The chat branch here
 * fetched the retired built-in local chat model's weights through
 * `local-llm-artifacts`; no chat provider ships weights now.
 */
async function downloadModel(model: DbModel, deps: DownloadDeps): Promise<void> {
  return downloadEmbeddingModel(model, deps);
}

/**
 * Refetch the registry. A missing database is surfaced as a destructive toast
 * (the `useModelToggle` contract), never a silent no-op.
 */
function useRegistryRefresh(): () => void {
  const db = useModelRegistrySource();
  const fetchRegistry = useModelRegistryStore((state) => state.fetchRegistry);
  const { toast } = useToast();
  return useCallback((): void => {
    if (!db) {
      toast({
        description: DATABASE_NOT_READY,
        title: 'Could not refresh the model registry',
        variant: 'destructive',
      });
      return;
    }
    void fetchRegistry(db);
  }, [db, fetchRegistry, toast]);
}

/** Model Catalog category header controls: local cache directory + registry refresh. */
export function ModelCatalogHeaderActions() {
  const isLoading = useModelRegistryStore((state) => state.isLoading);
  const refresh = useRegistryRefresh();
  return (
    <div className="flex items-center gap-2">
      <Button
        aria-label="Refresh model registry"
        data-testid="model-registry-refresh"
        disabled={isLoading}
        onClick={refresh}
        size="icon-sm"
        title="Refresh model registry"
        variant="outline"
      >
        <RefreshCw
          className={cn('size-4', isLoading && 'animate-spin motion-reduce:animate-none')}
        />
      </Button>
    </div>
  );
}

export function ModelSelectionPage() {
  const { downloadedModels, downloadProgress, error, hasLoaded, isDownloading, models, providers } =
    useModelRegistryStore(
      useShallow((state) => ({
        downloadedModels: state.downloadedModels,
        downloadProgress: state.downloadProgress,
        error: state.error,
        hasLoaded: state.hasLoaded,
        isDownloading: state.isDownloading,
        models: state.models,
        providers: state.providers,
      }))
    );
  const { toast } = useToast();
  // Shared with the Provider Hub cards: one implementation of "enable this
  // model", so a failure is reported the same way on both surfaces. Bulk
  // changes go through the same controller (one busy set, one failure path).
  const { busyModelIds, toggle, toggleMany } = useModelToggle();
  const applyBulkChange = useModelBulkToggle({ busyModelIds, toggleMany });

  useEnsureModelRegistry();
  useDownloadedModelsRead();

  // Reads the store at call time so the handler stays identity-stable while
  // download progress ticks (TreeGrid contract: stable row-facing callbacks).
  const handleDownload = useCallback(
    (modelId: string): void => {
      const registry = useModelRegistryStore.getState();
      if (registry.isDownloading[modelId]) {
        return;
      }
      const model = registry.models.find((m) => m.id === modelId);
      if (!model) {
        logger.error('Download requested for a model not in the catalog', { modelId });
        toast({
          description: `${modelId} is not in the model catalog.`,
          title: 'Could not download model',
          variant: 'destructive',
        });
        return;
      }
      void downloadModel(model, {
        setDownloading: registry.setDownloading,
        setDownloadProgress: registry.setDownloadProgress,
        toast,
      });
    },
    [toast]
  );

  const handleToggle = useCallback(
    (modelId: string, enabled: boolean): void => {
      void toggle(modelId, enabled);
    },
    [toggle]
  );

  const handleBulkChange = useCallback(
    (change: ModelBulkChange): void => {
      void applyBulkChange(change);
    },
    [applyBulkChange]
  );

  const handleRefresh = useRegistryRefresh();

  if (error) {
    return (
      <div
        className="rounded-md bg-destructive/10 p-4 text-destructive"
        data-testid="model-registry-error"
      >
        <p className="font-medium">Error loading models</p>
        <p className="text-sm">{error}</p>
        <Button
          className="mt-2"
          data-testid="model-registry-retry"
          onClick={handleRefresh}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <ModelCatalog
      busyModelIds={busyModelIds}
      downloadedModels={downloadedModels}
      downloadProgress={downloadProgress}
      isDownloading={isDownloading}
      loaded={hasLoaded}
      models={models}
      onBulkChange={handleBulkChange}
      onDownload={handleDownload}
      onRefresh={handleRefresh}
      onToggle={handleToggle}
      providers={providers}
    />
  );
}
