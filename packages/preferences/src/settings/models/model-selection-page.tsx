import { DEFAULT_EMBEDDING_DIMENSION, usePGliteDatabase } from '@brainstrike/db';
import type { ModelConfig } from '@brainstrike/embeddings';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { Button, Input, Label, useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { Folder, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useEnsureModelRegistry } from '../../hooks/use-model-registry';
import type { DbModel } from '../../stores/model-registry-store';
import { useModelRegistryStore } from '../../stores/model-registry-store';
import { ModelList } from './model-list';

const logger = createLogger('ModelSelectionPage');

type ToastFn = ReturnType<typeof useToast>['toast'];

interface DownloadDeps {
  modelCacheDir: string | null;
  setDownloadProgress: (modelId: string, progress: number) => void;
  setDownloading: (modelId: string, isDownloading: boolean) => void;
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

async function downloadLlmModel(
  model: DbModel,
  { modelCacheDir, setDownloadProgress, setDownloading, toast }: DownloadDeps
): Promise<void> {
  // Dynamic import from client entry to avoid server-only Mastra dependencies
  const { LocalLlmBackend } = await import('@brainstrike/agent/client');

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
    await LocalLlmBackend.downloadModel(model.id, downloadOptions);

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

    try {
      setIsSelectingCacheDir(true);
      const handle = await requestDirectoryAccess();
      const selectedPath = typeof handle?.path === 'string' ? handle.path : '';

      if (!selectedPath) {
        toast({
          title: 'No directory selected',
          description: 'Please choose a folder to store local model files.',
          variant: 'destructive',
        });
        return;
      }

      setModelCacheDir(selectedPath);
      toast({
        title: 'Cache directory updated',
        description: selectedPath,
      });
      if (db) {
        void fetchRegistry(db);
      }
    } catch (err) {
      logger.error('Failed to select cache directory', err);
      toast({
        title: 'Directory selection failed',
        description: (err as Error).message,
        variant: 'destructive',
      });
    } finally {
      setIsSelectingCacheDir(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-destructive">
        <p className="font-medium">Error loading models</p>
        <p className="text-sm">{error}</p>
        <Button
          className="mt-2"
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
              id="model-cache-dir"
              onChange={(e) => setModelCacheDir(e.target.value)}
              placeholder="System default (Transformers.js cache)"
              value={modelCacheDir || ''}
            />
            <Button
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
        onToggle={(modelId, enabled) => db && toggleModel(db, modelId, enabled)}
        providers={providers}
      />
    </div>
  );
}
