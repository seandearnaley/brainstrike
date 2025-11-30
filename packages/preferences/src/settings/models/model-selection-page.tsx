import { usePGliteDatabase } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { Button, Input, Label, useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { Folder, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { useModelRegistryStore } from '../../stores/model-registry-store';
import { ModelList } from './model-list';

const logger = createLogger('ModelSelectionPage');

export function ModelSelectionPage() {
  const db = usePGliteDatabase();
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

  // biome-ignore lint/plugin: Fetch registry when db becomes available - data loading pattern
  useEffect(() => {
    if (db) {
      void fetchRegistry(db);
    }
  }, [db, fetchRegistry]);

  const handleDownload = async (modelId: string) => {
    if (isDownloading[modelId]) {
      return;
    }

    const model = models.find((m) => m.id === modelId);
    if (!model) {
      return;
    }

    try {
      setDownloading(modelId, true);
      setDownloadProgress(modelId, 0);

      const service = new SimpleEmbeddingService();

      // Map DbModel to ModelConfig
      const modelConfig = {
        id: model.id,
        name: model.name,
        description: model.description || '',
        dimensions: model.capabilities.defaultDimension || 768,
        tags: model.bestFor || [],
        quantized: false, // Default to false for now, or read from parameters if available
        // Add other optional fields if available in parameters
        ...(model.parameters as Record<string, unknown>),
      };

      toast({
        title: 'Download Started',
        description: `Starting download for ${model.name}...`,
      });

      // Pass full config to bypass registry lookup
      await service.downloadModel(modelId, {
        modelConfig,
        ...(modelCacheDir ? { cacheDir: modelCacheDir } : {}),
        onProgress: (p) => {
          if (p.progress !== undefined) {
            setDownloadProgress(modelId, p.progress);
          }
        },
      });

      setDownloadProgress(modelId, 100);
      toast({
        title: 'Download Complete',
        description: `${model.name} downloaded successfully!`,
      });
    } catch (err) {
      logger.error('Failed to download model', err);
      toast({
        title: 'Download Failed',
        description: `Failed to download ${model.name}: ${(err as Error).message}`,
        variant: 'destructive',
      });
    } finally {
      setDownloading(modelId, false);
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

  // Filter models
  // Filter models

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="font-semibold text-lg">Model Selection</h2>
          <p className="text-muted-foreground text-sm">
            Enable or disable models to be used across the application.
          </p>
        </div>
        <Button
          disabled={isLoading}
          onClick={() => db && fetchRegistry(db)}
          size="icon"
          title="Refresh Registry"
          variant="ghost"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="model-cache-dir">Model Cache Directory</Label>
        <div className="flex gap-2">
          <Input
            className="font-mono text-xs"
            id="model-cache-dir"
            onChange={(e) => setModelCacheDir(e.target.value)}
            placeholder="Default system cache directory"
            value={modelCacheDir || ''}
          />
          <Button size="icon" title="Select Directory" variant="outline">
            <Folder className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Directory where downloaded models are stored. Leave empty to use the system default.
        </p>
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
