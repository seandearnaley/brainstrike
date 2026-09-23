import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import type { EmbeddingModelConfig as ModelConfig } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { Button, cn, useToast } from '@brainstrike/ui';
import { RefreshCw } from 'lucide-react';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ModelCacheDirectoryPopover } from './model-cache-directory-popover';
import { ModelCatalog } from './model-catalog';
import { getModelRuntimeServices } from './model-runtime-services';
import { type ModelBulkChange, useModelBulkToggle } from './use-model-bulk-toggle';
import { useModelToggle } from './use-model-toggle';

const logger = createLogger('ModelSelectionPage');

type ToastFn = ReturnType<typeof useToast>['toast'];

interface DownloadDeps {
  modelCacheDir: string | null;
  setDownloading: (modelId: string, isDownloading: boolean) => void;
  setDownloadProgress: (modelId: string, progress: number) => void;
  toast: ToastFn;
}

interface DownloadProgress {
  progress?: number;
}

function readQuantizedFlag(parameters: Record<string, unknown> | null): boolean {
  const value = parameters?.['quantized'];
  return typeof value === 'boolean' ? value : false;
}

function buildModelConfig(model: DbModel): ModelConfig {
  const parameters = (model.parameters ?? {}) as Record<string, unknown>;
  return {
    description: model.description ?? '',
    dimensions: model.capabilities.defaultDimension ?? DEFAULT_EMBEDDING_DIMENSION,
    id: model.id,
    name: model.name,
    tags: Array.isArray(model.bestFor) ? model.bestFor : [],
    // Add other optional fields if available in parameters
    ...parameters,
    quantized: readQuantizedFlag(parameters),
  };
}

function updateProgress(
  modelId: string,
  setDownloadProgress: (modelId: string, progress: number) => void,
  progress: number | undefined
): void {
  if (progress !== undefined) {
    setDownloadProgress(modelId, progress);
  }
}

async function downloadLlmModel(
  model: DbModel,
  { modelCacheDir, setDownloadProgress, setDownloading, toast }: DownloadDeps
): Promise<void> {
  const { downloadBuiltInLocalLlmModel } = await import(
    '@brainstrike/assistant-contract/local-llm-artifacts'
  );

  setDownloading(model.id, true);
  setDownloadProgress(model.id, 0);

  try {
    toast({
      description: `Starting download for ${model.name}...`,
      title: 'Download Started',
    });

    const downloadOptions: {
      cacheDir?: string;
      onProgress: (progress: { progress: number }) => void;
    } = {
      onProgress: (progress) => {
        setDownloadProgress(model.id, progress.progress);
      },
    };
    if (modelCacheDir) {
      downloadOptions.cacheDir = modelCacheDir;
    }
    await downloadBuiltInLocalLlmModel(model.id, downloadOptions);

    setDownloadProgress(model.id, 100);
    toast({
      description: `${model.name} downloaded successfully!`,
      title: 'Download Complete',
    });
  } catch (err) {
    logger.error('Failed to download LLM model', err);
    toast({
      description: `Failed to download ${model.name}: ${(err as Error).message}`,
      title: 'Download Failed',
      variant: 'destructive',
    });
  } finally {
    setDownloading(model.id, false);
  }
}

async function downloadEmbeddingModel(
  model: DbModel,
  { modelCacheDir, setDownloadProgress, setDownloading, toast }: DownloadDeps
): Promise<void> {
  const { downloadEmbeddingModel: runEmbeddingModelDownload } = getModelRuntimeServices();
  const modelConfig = buildModelConfig(model);

  setDownloading(model.id, true);
  setDownloadProgress(model.id, 0);

  try {
    toast({
      description: `Starting download for ${model.name}...`,
      title: 'Download Started',
    });

    const options: {
      modelConfig: ModelConfig;
      cacheDir?: string;
      onProgress: (progress: DownloadProgress) => void;
    } = {
      modelConfig,
      onProgress: (progress) => updateProgress(model.id, setDownloadProgress, progress.progress),
    };

    if (modelCacheDir) {
      options.cacheDir = modelCacheDir;
    }

    // Pass full config to bypass registry lookup
    await runEmbeddingModelDownload(model.id, options);

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

async function downloadModel(model: DbModel, deps: DownloadDeps): Promise<void> {
  // Route to appropriate downloader based on model type
  if (model.capabilities.type === 'llm') {
    return downloadLlmModel(model, deps);
  }
  return downloadEmbeddingModel(model, deps);
}

/** Model Catalog category header controls: local cache directory + registry refresh. */
export function ModelCatalogHeaderActions() {
  const db = usePGliteDatabase();
  const { fetchRegistry, isLoading } = useModelRegistryStore(
    useShallow((state) => ({ fetchRegistry: state.fetchRegistry, isLoading: state.isLoading }))
  );
  return (
    <div className="flex items-center gap-2">
      <ModelCacheDirectoryPopover />
      <Button
        aria-label="Refresh model registry"
        data-testid="model-registry-refresh"
        disabled={isLoading}
        onClick={() => db && fetchRegistry(db)}
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
  const db = usePGliteDatabase();
  const {
    downloadedModels,
    downloadProgress,
    error,
    fetchRegistry,
    hasLoaded,
    isDownloading,
    modelCacheDir,
    models,
    providers,
  } = useModelRegistryStore(
    useShallow((state) => ({
      downloadedModels: state.downloadedModels,
      downloadProgress: state.downloadProgress,
      error: state.error,
      fetchRegistry: state.fetchRegistry,
      hasLoaded: state.hasLoaded,
      isDownloading: state.isDownloading,
      modelCacheDir: state.modelCacheDir,
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

  useEnsureModelRegistry({ db });

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
        return;
      }
      void downloadModel(model, {
        modelCacheDir: registry.modelCacheDir,
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

  const handleRefresh = useCallback((): void => {
    if (db) {
      void fetchRegistry(db);
    }
  }, [db, fetchRegistry]);

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
          onClick={() => db && fetchRegistry(db)}
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
      modelCacheDir={modelCacheDir}
      models={models}
      onBulkChange={handleBulkChange}
      onDownload={handleDownload}
      onRefresh={handleRefresh}
      onToggle={handleToggle}
      providers={providers}
    />
  );
}
