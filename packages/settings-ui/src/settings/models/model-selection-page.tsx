import { resolveCacheDirectorySelectionTestOverride } from '@brainstrike/app-state/automation-overrides';
import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import type { EmbeddingModelConfig as ModelConfig } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { Button, Input, Label, useToast } from '@brainstrike/ui';
import { Folder, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ModelList } from './model-list';
import { getModelRuntimeServices } from './model-runtime-services';
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

function applySelectedCacheDirectory(args: {
  db: ReturnType<typeof usePGliteDatabase>;
  fetchRegistry: (db: NonNullable<ReturnType<typeof usePGliteDatabase>>) => Promise<void>;
  selectedPath: string;
  setModelCacheDir: (dir: string) => void;
  toast: ToastFn;
}): void {
  args.setModelCacheDir(args.selectedPath);
  args.toast({
    description: args.selectedPath,
    title: 'Cache directory updated',
  });
  if (args.db) {
    void args.fetchRegistry(args.db).catch((error: unknown) => {
      logger.warn('Failed to refresh model registry after cache directory change', { error });
    });
  }
}

function applyCacheDirectorySelectionTestOverride(args: {
  db: ReturnType<typeof usePGliteDatabase>;
  fetchRegistry: (db: NonNullable<ReturnType<typeof usePGliteDatabase>>) => Promise<void>;
  setModelCacheDir: (dir: string) => void;
  toast: ToastFn;
}): boolean {
  const resolution = resolveCacheDirectorySelectionTestOverride();
  if (resolution.kind === 'none') {
    return false;
  }

  switch (resolution.kind) {
    case 'unavailable':
      args.toast({
        description: 'Choose a cache directory from the desktop app.',
        title: 'Directory selection unavailable',
        variant: 'destructive',
      });
      return true;
    case 'error':
      args.toast({
        description: resolution.message,
        title: 'Directory selection failed',
        variant: 'destructive',
      });
      return true;
    case 'cancelled':
      args.toast({
        description: 'Please choose a folder to store local model files.',
        title: 'No directory selected',
        variant: 'destructive',
      });
      return true;
    case 'selected':
      applySelectedCacheDirectory({
        db: args.db,
        fetchRegistry: args.fetchRegistry,
        selectedPath: resolution.path,
        setModelCacheDir: args.setModelCacheDir,
        toast: args.toast,
      });
      return true;
    default: {
      const exhaustiveResolution: never = resolution;
      return exhaustiveResolution;
    }
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

export function ModelSelectionPage() {
  const db = usePGliteDatabase();
  const [isSelectingCacheDir, setIsSelectingCacheDir] = useState<boolean>(false);
  const {
    providers,
    models,
    isLoading,
    error,
    modelCacheDir,
    downloadProgress,
    isDownloading,
    downloadedModels,
    fetchRegistry,
    setModelCacheDir,
    setDownloadProgress,
    setDownloading,
  } = useModelRegistryStore(
    useShallow((state) => ({
      downloadedModels: state.downloadedModels,
      downloadProgress: state.downloadProgress,
      error: state.error,
      fetchRegistry: state.fetchRegistry,
      isDownloading: state.isDownloading,
      isLoading: state.isLoading,
      modelCacheDir: state.modelCacheDir,
      models: state.models,
      providers: state.providers,
      setDownloading: state.setDownloading,
      setDownloadProgress: state.setDownloadProgress,
      setModelCacheDir: state.setModelCacheDir,
    }))
  );
  const { toast } = useToast();
  // Shared with the Provider Hub cards: one implementation of "enable this
  // model", so a failure is reported the same way on both surfaces.
  const { busyModelIds, toggle: toggleModel } = useModelToggle();

  useEnsureModelRegistry({ db });

  const handleDownload = async (modelId: string) => {
    if (isDownloading[modelId]) {
      return;
    }

    const model = models.find((m) => m.id === modelId);
    if (!model) {
      return;
    }

    await downloadModel(model, {
      modelCacheDir,
      setDownloading,
      setDownloadProgress,
      toast,
    });
  };

  const handleSelectCacheDir = async (): Promise<void> => {
    if (
      applyCacheDirectorySelectionTestOverride({
        db,
        fetchRegistry,
        setModelCacheDir,
        toast,
      })
    ) {
      return;
    }

    const requestDirectoryAccess = (
      window as unknown as {
        electronAPI?: {
          fileSystem?: { requestDirectoryAccess?: () => Promise<{ path?: string }> };
        };
      }
    ).electronAPI?.fileSystem?.requestDirectoryAccess;

    if (typeof requestDirectoryAccess !== 'function') {
      toast({
        description: 'Choose a cache directory from the desktop app.',
        title: 'Directory selection unavailable',
        variant: 'destructive',
      });
      return;
    }

    setIsSelectingCacheDir(true);

    let selectedPath = '';
    try {
      const handle = await requestDirectoryAccess();
      if (typeof handle.path === 'string') {
        selectedPath = handle.path;
      }
    } catch (err) {
      logger.error('Failed to select cache directory', err);
      toast({
        description: (err as Error).message,
        title: 'Directory selection failed',
        variant: 'destructive',
      });
      setIsSelectingCacheDir(false);
      return;
    }

    if (!selectedPath) {
      toast({
        description: 'Please choose a folder to store local model files.',
        title: 'No directory selected',
        variant: 'destructive',
      });
      setIsSelectingCacheDir(false);
      return;
    }

    applySelectedCacheDirectory({
      db,
      fetchRegistry,
      selectedPath,
      setModelCacheDir,
      toast,
    });
    setIsSelectingCacheDir(false);
  };

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
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <Label htmlFor="model-cache-dir">Local Model Cache Directory</Label>
          <div className="flex gap-2">
            <Input
              className="font-mono text-xs"
              data-testid="model-cache-dir-input"
              id="model-cache-dir"
              onChange={(e) => setModelCacheDir(e.target.value)}
              placeholder="System default (Transformers.js cache)"
              value={modelCacheDir || ''}
            />
            <Button
              aria-label="Select Model Cache Directory"
              data-testid="model-cache-dir-select"
              disabled={isSelectingCacheDir}
              onClick={handleSelectCacheDir}
              size="icon"
              title="Select Directory"
              variant="outline"
            >
              <Folder className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Stored on disk for local models only. Leave blank to use the system cache directory.
          </p>
        </div>
        <Button
          aria-label="Refresh model registry"
          data-testid="model-registry-refresh"
          disabled={isLoading}
          onClick={() => db && fetchRegistry(db)}
          size="icon"
          title="Refresh model registry"
          variant="outline"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <ModelList
        downloadedModels={downloadedModels}
        downloadProgress={downloadProgress}
        isDownloading={isDownloading}
        modelCacheDir={modelCacheDir}
        models={models}
        onDownload={handleDownload}
        onToggle={toggleModel}
        pendingModelIds={busyModelIds}
        providers={providers}
      />
    </div>
  );
}
