import { usePGliteDatabase } from '@brainstrike/db';
import { Badge, Button, Card, Input, Label, Progress, Switch, useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { ChevronDown, ChevronRight, Download, Folder, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useEnsureModelRegistry } from '../../hooks/use-model-registry';
import { useModelRegistryStore } from '../../stores/model-registry-store';
import { getModelRuntimeServices } from './model-runtime-services';

const logger = createLogger('ModelRegistrySettingsSection');

export function ModelRegistrySettingsSection() {
  const { toast } = useToast();
  const db = usePGliteDatabase();
  const {
    providers,
    models,
    isLoading,
    error,
    modelCacheDir,
    downloadProgress,
    isDownloading,
    fetchRegistry,
    toggleProvider,
    toggleModel,
    setModelCacheDir,
    setDownloadProgress,
    setDownloading,
  } = useModelRegistryStore();
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());

  useEnsureModelRegistry({ db });

  const toggleExpanded = (providerId: string) => {
    const next = new Set(expandedProviders);
    if (next.has(providerId)) {
      next.delete(providerId);
    } else {
      next.add(providerId);
    }
    setExpandedProviders(next);
  };

  const handleDownload = async (modelId: string) => {
    if (isDownloading[modelId]) {
      return;
    }

    const cacheDir = modelCacheDir ?? undefined;
    const cacheDirOption = cacheDir ? { cacheDir } : {};
    const { downloadEmbeddingModel } = getModelRuntimeServices();
    setDownloading(modelId, true);
    setDownloadProgress(modelId, 0);
    try {
      await downloadEmbeddingModel(modelId, {
        ...cacheDirOption,
        onProgress: (p) => {
          if (p.progress !== undefined) {
            setDownloadProgress(modelId, p.progress);
          }
        },
      });

      setDownloadProgress(modelId, 100);
    } catch (err) {
      logger.error('Failed to download model', err);
      toast({
        title: 'Download Failed',
        description:
          err instanceof Error
            ? err.message
            : 'An unknown error occurred while downloading the model.',
        variant: 'destructive',
      });
    }
    setDownloading(modelId, false);
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
          <Button
            aria-label="Select Model Cache Directory"
            size="icon"
            title="Select Directory"
            variant="outline"
          >
            <Folder className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Directory where downloaded models are stored. Leave empty to use the system default.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Manage available AI providers and models. Disabled models will not appear in the prompt
          editor.
        </p>
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

      <div className="space-y-4">
        {providers.map((provider) => {
          const providerModels = models.filter((m) => m.providerId === provider.id);
          const isExpanded = expandedProviders.has(provider.id);

          return (
            <Card className="overflow-hidden" key={provider.id}>
              <div className="flex items-center gap-4 bg-muted/20 p-4">
                <Button
                  aria-label={isExpanded ? `Collapse ${provider.name}` : `Expand ${provider.name}`}
                  className="h-6 w-6 shrink-0"
                  onClick={() => toggleExpanded(provider.id)}
                  size="icon"
                  variant="ghost"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>

                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{provider.name}</span>
                    <Badge className="font-normal text-xs" variant="outline">
                      {providerModels.length} models
                    </Badge>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Label className="sr-only" htmlFor={`provider-${provider.id}`}>
                    Enable {provider.name}
                  </Label>
                  <Switch
                    checked={provider.isEnabled}
                    id={`provider-${provider.id}`}
                    onCheckedChange={(checked) => db && toggleProvider(db, provider.id, checked)}
                  />
                </div>
              </div>

              {isExpanded && (
                <div className="space-y-3 border-border border-t p-4">
                  {providerModels.length === 0 ? (
                    <p className="py-4 text-center text-muted-foreground text-sm">
                      No models found.
                    </p>
                  ) : (
                    providerModels.map((model) => (
                      <Card className="bg-card/50 p-3" key={model.id}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{model.name}</span>
                              {model.capabilities.type === 'embedding' && (
                                <Badge className="h-4 px-1 text-[10px]" variant="secondary">
                                  Embedding
                                </Badge>
                              )}
                              {model.capabilities.streaming && (
                                <Badge className="h-4 px-1 text-[10px]" variant="secondary">
                                  Streaming
                                </Badge>
                              )}
                            </div>
                            <p className="font-mono text-muted-foreground text-xs">{model.id}</p>
                            {model.description && (
                              <p className="text-muted-foreground text-xs">{model.description}</p>
                            )}

                            {/* Download Progress */}
                            {isDownloading[model.id] && (
                              <div className="mt-2 space-y-1">
                                <div className="flex justify-between text-[10px] text-muted-foreground">
                                  <span>Downloading...</span>
                                  <span>{downloadProgress[model.id] || 0}%</span>
                                </div>
                                <Progress
                                  aria-label="Model download progress"
                                  className="h-1"
                                  value={downloadProgress[model.id] || 0}
                                />
                              </div>
                            )}
                          </div>

                          <div className="flex flex-col items-end gap-2">
                            <div className="flex items-center gap-2">
                              {/* Only show download for local models (provider id 'local' or similar logic) */}
                              {provider.id === 'local' && (
                                <Button
                                  className="h-7 gap-1 text-xs"
                                  disabled={isDownloading[model.id]}
                                  onClick={() => handleDownload(model.id)}
                                  size="sm"
                                  variant="outline"
                                >
                                  <Download className="h-3 w-3" />
                                  {isDownloading[model.id] ? 'Downloading' : 'Download'}
                                </Button>
                              )}
                              <Switch
                                aria-label={`Enable ${model.name}`}
                                checked={model.isEnabled}
                                disabled={!provider.isEnabled}
                                onCheckedChange={(checked) =>
                                  db && toggleModel(db, model.id, checked)
                                }
                              />
                            </div>
                          </div>
                        </div>
                      </Card>
                    ))
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
