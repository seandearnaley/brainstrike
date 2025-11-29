import { usePGliteDatabase } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { Badge, Button, Card, Input, Label, Progress, Switch } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { ChevronDown, ChevronRight, Download, Folder, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useModelRegistryStore } from '../../stores/model-registry-store';

const logger = createLogger('ModelRegistrySettingsSection');

export function ModelRegistrySettingsSection() {
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

  useEffect(() => {
    if (db) {
      void fetchRegistry(db);
    }
  }, [db, fetchRegistry]);

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
    if (isDownloading[modelId]) return;

    try {
      setDownloading(modelId, true);
      setDownloadProgress(modelId, 0);

      const service = new SimpleEmbeddingService();
      await service.downloadModel(modelId, {
        ...(modelCacheDir ? { cacheDir: modelCacheDir } : {}),
        onProgress: (p) => {
          if (p.progress !== undefined) {
            setDownloadProgress(modelId, p.progress);
          }
        },
      });

      setDownloadProgress(modelId, 100);
    } catch (err) {
      logger.error('Failed to download model', err);
      // TODO: Show error toast
    } finally {
      setDownloading(modelId, false);
    }
  };

  if (error) {
    return (
      <div className="p-4 rounded-md bg-destructive/10 text-destructive">
        <p className="font-medium">Error loading models</p>
        <p className="text-sm">{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => db && fetchRegistry(db)}
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
            id="model-cache-dir"
            value={modelCacheDir || ''}
            onChange={(e) => setModelCacheDir(e.target.value)}
            placeholder="Default system cache directory"
            className="font-mono text-xs"
          />
          <Button variant="outline" size="icon" title="Select Directory">
            <Folder className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Directory where downloaded models are stored. Leave empty to use the system default.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Manage available AI providers and models. Disabled models will not appear in the prompt
          editor.
        </p>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => db && fetchRegistry(db)}
          disabled={isLoading}
          title="Refresh Registry"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <div className="space-y-4">
        {providers.map((provider) => {
          const providerModels = models.filter((m) => m.providerId === provider.id);
          const isExpanded = expandedProviders.has(provider.id);

          return (
            <Card key={provider.id} className="overflow-hidden">
              <div className="p-4 flex items-center gap-4 bg-muted/20">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => toggleExpanded(provider.id)}
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
                    <Badge variant="outline" className="text-xs font-normal">
                      {providerModels.length} models
                    </Badge>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Label htmlFor={`provider-${provider.id}`} className="sr-only">
                    Enable {provider.name}
                  </Label>
                  <Switch
                    id={`provider-${provider.id}`}
                    checked={provider.isEnabled}
                    onCheckedChange={(checked) => db && toggleProvider(db, provider.id, checked)}
                  />
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-border p-4 space-y-3">
                  {providerModels.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No models found.
                    </p>
                  ) : (
                    providerModels.map((model) => (
                      <Card key={model.id} className="p-3 bg-card/50">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{model.name}</span>
                              {model.capabilities.type === 'embedding' && (
                                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                                  Embedding
                                </Badge>
                              )}
                              {model.capabilities.streaming && (
                                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                                  Streaming
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground font-mono">{model.id}</p>
                            {model.description && (
                              <p className="text-xs text-muted-foreground">{model.description}</p>
                            )}

                            {/* Download Progress */}
                            {isDownloading[model.id] && (
                              <div className="mt-2 space-y-1">
                                <div className="flex justify-between text-[10px] text-muted-foreground">
                                  <span>Downloading...</span>
                                  <span>{downloadProgress[model.id] || 0}%</span>
                                </div>
                                <Progress value={downloadProgress[model.id] || 0} className="h-1" />
                              </div>
                            )}
                          </div>

                          <div className="flex flex-col items-end gap-2">
                            <div className="flex items-center gap-2">
                              {/* Only show download for local models (provider id 'local' or similar logic) */}
                              {provider.id === 'local' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs gap-1"
                                  onClick={() => handleDownload(model.id)}
                                  disabled={isDownloading[model.id]}
                                >
                                  <Download className="h-3 w-3" />
                                  {isDownloading[model.id] ? 'Downloading' : 'Download'}
                                </Button>
                              )}
                              <Switch
                                checked={model.isEnabled}
                                disabled={!provider.isEnabled}
                                onCheckedChange={(checked) =>
                                  db && toggleModel(db, model.id, checked)
                                }
                                aria-label={`Enable ${model.name}`}
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
