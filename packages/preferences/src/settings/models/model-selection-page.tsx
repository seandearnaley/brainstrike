import { DEFAULT_EMBEDDING_DIMENSION, usePGliteDatabase } from '@brainstrike/db';
import type { EmbeddingModelConfig as ModelConfig } from '@brainstrike/indexing-contract';
import { Button, Input, Label, useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { Folder, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useEnsureModelRegistry } from '../../hooks/use-model-registry';
import { resolveCacheDirectorySelectionTestOverride } from '../../settings-test-runtime-access';
import type { DbModel } from '../../stores/model-registry-store';
import { useModelRegistryStore } from '../../stores/model-registry-store';
import { AssistantMemorySettingsSection } from './assistant-memory-settings-section';
import { ModelList } from './model-list';

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
    id: model.id,
    name: model.name,
    description: model.description ?? '',
    dimensions: model.capabilities.defaultDimension ?? DEFAULT_EMBEDDING_DIMENSION,
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
    title: 'Cache directory updated',
    description: args.selectedPath,
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
        title: 'Directory selection unavailable',
        description: 'Choose a cache directory from the desktop app.',
        variant: 'destructive',
      });
      return true;
    case 'error':
      args.toast({
        title: 'Directory selection failed',
        description: resolution.message,
        variant: 'destructive',
      });
      return true;
    case 'cancelled':
      args.toast({
        title: 'No directory selected',
        description: 'Please choose a folder to store local model files.',
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
      title: 'Download Started',
      description: `Starting download for ${model.name}...`,
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
      title: 'Download Complete',
      description: `${model.name} downloaded successfully!`,
    });
  } catch (err) {
    logger.error('Failed to download LLM model', err);
    toast({
      title: 'Download Failed',
      description: `Failed to download ${model.name}: ${(err as Error).message}`,
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
  const { SimpleEmbeddingService } = await import('@brainstrike/embeddings/service');
  const service = new SimpleEmbeddingService();
  const modelConfig = buildModelConfig(model);

  setDownloading(model.id, true);
  setDownloadProgress(model.id, 0);

  try {
    toast({
      title: 'Download Started',
      description: `Starting download for ${model.name}...`,
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
    await service.downloadModel(model.id, options);

    setDownloadProgress(model.id, 100);
    toast({
      title: 'Download Complete',
      description: `${model.name} downloaded successfully!`,
    });
  } catch (err) {
    logger.error('Failed to download embedding model', err);
    toast({
      title: 'Download Failed',
      description: `Failed to download ${model.name}: ${(err as Error).message}`,
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
  const [pendingModelIds, setPendingModelIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
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
    toggleModel,
    setModelCacheDir,
    setDownloadProgress,
    setDownloading,
  } = useModelRegistryStore();
  const { toast } = useToast();

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
      setDownloadProgress,
      setDownloading,
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
        title: 'Directory selection unavailable',
        description: 'Choose a cache directory from the desktop app.',
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
        title: 'Directory selection failed',
        description: (err as Error).message,
        variant: 'destructive',
      });
      setIsSelectingCacheDir(false);
      return;
    }

    if (!selectedPath) {
      toast({
        title: 'No directory selected',
        description: 'Please choose a folder to store local model files.',
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

  const handleToggleModel = async (modelId: string, enabled: boolean): Promise<void> => {
    if (!db) {
      return;
    }

    setPendingModelIds((current) => {
      const next = new Set(current);
      next.add(modelId);
      return next;
    });

    try {
      await toggleModel(db, modelId, enabled);
    } finally {
      setPendingModelIds((current) => {
        const next = new Set(current);
        next.delete(modelId);
        return next;
      });
    }
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

      <AssistantMemorySettingsSection />

      <ModelList
        downloadedModels={downloadedModels}
        downloadProgress={downloadProgress}
        isDownloading={isDownloading}
        modelCacheDir={modelCacheDir}
        models={models}
        onDownload={handleDownload}
        onToggle={(modelId, enabled) => {
          void handleToggleModel(modelId, enabled);
        }}
        pendingModelIds={pendingModelIds}
        providers={providers}
      />
    </div>
  );
}
