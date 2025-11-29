import { usePGliteDatabase } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useToast,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { Check, Download, Folder, Loader2, RefreshCw, Search, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type DbModel, useModelRegistryStore } from '../../stores/model-registry-store';
import LlmKeysSettings from '../secrets/llm-keys-settings';
import { filterModels } from './model-filters';

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

  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    if (db) {
      void fetchRegistry(db);
    }
  }, [db, fetchRegistry]);

  const handleDownload = async (modelId: string) => {
    if (isDownloading[modelId]) return;

    const model = models.find((m) => m.id === modelId);
    if (!model) return;

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

  // Filter models
  // Filter models
  const filteredModels = filterModels(
    models,
    searchQuery,
    providerFilter,
    typeFilter,
    statusFilter,
    downloadedModels
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Model Selection</h2>
        </div>
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

      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search models..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 w-[200px] lg:w-[300px]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={providerFilter} onValueChange={setProviderFilter}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Providers</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="chat">Chat</SelectItem>
              <SelectItem value="embedding">Embedding</SelectItem>
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="downloaded">Downloaded</SelectItem>
              <SelectItem value="remote">Remote</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {filteredModels.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            No models found matching your filters.
          </div>
        ) : (
          filteredModels.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              providerName={providers.find((p) => p.id === model.providerId)?.name}
              onToggle={(enabled) => db && toggleModel(db, model.id, enabled)}
              onDownload={() => handleDownload(model.id)}
              isDownloading={isDownloading[model.id]}
              downloadProgress={downloadProgress[model.id]}
              isDownloaded={model.capabilities.type === 'llm' ? true : downloadedModels[model.id]}
              showDownload={model.providerId === 'transformers' || model.providerId === 'local'}
              cacheDir={modelCacheDir || undefined}
            />
          ))
        )}
      </div>

      {/* Only show API Keys settings if the secrets API is available (Desktop) */}
      {window.secrets ? (
        <div className="pt-6 border-t">
          <LlmKeysSettings />
        </div>
      ) : null}
    </div>
  );
}

interface ModelCardProps {
  model: DbModel;
  providerName?: string | undefined;
  onToggle: (enabled: boolean) => void;
  onDownload?: (() => void) | undefined;
  isDownloading?: boolean | undefined;
  downloadProgress?: number | undefined;
  isDownloaded?: boolean | undefined;
  showDownload?: boolean | undefined;
  cacheDir?: string | undefined;
}

function ModelCard({
  model,
  providerName,
  onToggle,
  onDownload,
  isDownloading,
  downloadProgress,
  isDownloaded,
  showDownload,
  cacheDir,
}: ModelCardProps) {
  const parameters = model.parameters as Record<string, unknown> | undefined;
  const size = parameters?.['size'] as string | undefined;

  return (
    <Card className="p-4 transition-all hover:shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-base">{model.name}</h3>
            {providerName && (
              <Badge variant="outline" className="text-xs font-normal">
                {providerName}
              </Badge>
            )}
            {model.capabilities.streaming && (
              <Badge variant="secondary" className="text-[10px] h-5 px-1.5 gap-1">
                <Zap className="h-3 w-3" />
                Streaming
              </Badge>
            )}
            {isDownloaded && showDownload && (
              <Badge
                variant="default"
                className="text-[10px] h-5 px-1.5 gap-1 bg-green-600 hover:bg-green-700 text-white"
              >
                <Check className="h-3 w-3" />
                Downloaded
              </Badge>
            )}
          </div>

          {model.tagline && <p className="text-sm font-medium text-primary">{model.tagline}</p>}

          <div className="text-sm text-muted-foreground">
            <p>{model.description}</p>
            <p className="text-xs font-mono mt-1 opacity-70">{model.id}</p>
            {size && <p className="text-xs mt-1 text-muted-foreground">Size: {size}</p>}
            {isDownloaded && cacheDir && (
              <p className="text-xs font-mono mt-1 text-muted-foreground break-all">
                Path: {cacheDir}/{model.id}
              </p>
            )}
          </div>

          {model.bestFor && model.bestFor.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {model.bestFor.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-5">
                  {tag}
                </Badge>
              ))}
            </div>
          )}

          {isDownloading && (
            <div className="mt-2 space-y-1 max-w-xs">
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Downloading...
                </span>
                <span>{downloadProgress || 0}%</span>
              </div>
              <Progress value={downloadProgress || 0} className="h-1" />
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-3">
          <Switch
            checked={model.isEnabled}
            onCheckedChange={onToggle}
            aria-label={`Enable ${model.name}`}
          />

          {showDownload && !isDownloaded && !isDownloading && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={onDownload}
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
