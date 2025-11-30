import { Badge, Button, Card, cn, Input, ScrollArea, Switch } from '@brainstrike/ui';
import { Check, Download, Loader2, Search, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DbModel, DbProvider } from '../../stores/model-registry-store';

type ModelListProps = {
  models: DbModel[];
  providers: DbProvider[];
  onToggle: (modelId: string, enabled: boolean) => void;
  onDownload: (modelId: string) => void;
  isDownloading: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  downloadedModels: Record<string, boolean>;
  modelCacheDir?: string | null;
};

// Deterministic color generator
function stringToColor(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00_ff_ff_ff).toString(16).toUpperCase();
  return `#${'00000'.substring(0, 6 - c.length)}${c}`;
}

export function ModelList({
  models,
  providers,
  onToggle,
  onDownload,
  isDownloading,
  downloadProgress,
  downloadedModels,
  modelCacheDir,
}: ModelListProps) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'chat' | 'embedding'>('all');

  const filteredModels = useMemo(
    () =>
      models.filter((model) => {
        const matchesSearch =
          model.name.toLowerCase().includes(search.toLowerCase()) ||
          model.providerId.toLowerCase().includes(search.toLowerCase()) ||
          (model.description?.toLowerCase().includes(search.toLowerCase()) ?? false);

        const matchesType =
          typeFilter === 'all' ||
          (typeFilter === 'chat' && model.capabilities.type === 'llm') ||
          (typeFilter === 'embedding' && model.capabilities.type === 'embedding');

        return matchesSearch && matchesType;
      }),
    [models, search, typeFilter]
  );

  const groupedModels = useMemo(() => {
    const groups: Record<string, DbModel[]> = {};
    for (const model of filteredModels) {
      const provider = providers.find((p) => p.id === model.providerId);
      const groupKey = provider ? provider.name : 'Unknown Provider';
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(model);
    }
    return groups;
  }, [filteredModels, providers]);

  return (
    <div className="flex h-full flex-col space-y-4">
      <div className="flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute top-2.5 left-2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            value={search}
          />
        </div>
        <div className="flex gap-2 rounded-lg border p-1">
          <Button
            className={cn(
              'h-7 text-xs',
              typeFilter === 'all' && 'bg-accent text-accent-foreground'
            )}
            onClick={() => setTypeFilter('all')}
            size="sm"
            variant="ghost"
          >
            All
          </Button>
          <Button
            className={cn(
              'h-7 text-xs',
              typeFilter === 'chat' && 'bg-accent text-accent-foreground'
            )}
            onClick={() => setTypeFilter('chat')}
            size="sm"
            variant="ghost"
          >
            Chat
          </Button>
          <Button
            className={cn(
              'h-7 text-xs',
              typeFilter === 'embedding' && 'bg-accent text-accent-foreground'
            )}
            onClick={() => setTypeFilter('embedding')}
            size="sm"
            variant="ghost"
          >
            Embedding
          </Button>
        </div>
      </div>

      <ScrollArea className="h-[600px] rounded-md border p-4">
        <div className="space-y-8">
          {Object.entries(groupedModels).map(([providerName, groupModels]) => (
            <div className="space-y-3" key={providerName}>
              <div className="flex items-center gap-2">
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: stringToColor(providerName) }}
                />
                <h3 className="font-semibold text-sm">{providerName}</h3>
                <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
                  {groupModels.length}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {groupModels.map((model) => (
                  <Card
                    className="flex items-center justify-between p-3 transition-colors hover:bg-accent/50"
                    key={model.id}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div
                        className="h-8 w-1 shrink-0 rounded-full"
                        style={{ backgroundColor: stringToColor(model.id) }}
                      />
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-sm">{model.name}</span>
                          {model.capabilities.type === 'embedding' && (
                            <Badge className="h-4 px-1 text-[10px]" variant="outline">
                              Embedding
                            </Badge>
                          )}
                          {model.capabilities.streaming && (
                            <Zap className="h-3 w-3 text-yellow-500" />
                          )}
                        </div>
                        <p className="truncate text-muted-foreground text-xs">
                          {model.description || model.id}
                        </p>
                        {downloadedModels[model.id] && modelCacheDir && (
                          <p className="truncate font-mono text-[10px] text-muted-foreground">
                            {modelCacheDir}/{model.id}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-4">
                      {(model.providerId === 'local' || model.providerId === 'transformers') && (
                        <div className="flex items-center">
                          {isDownloading[model.id] ? (
                            <div className="flex items-center gap-2 text-muted-foreground text-xs">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {downloadProgress[model.id]}%
                            </div>
                          ) : downloadedModels[model.id] ? (
                            <Badge
                              className="bg-green-500/10 text-green-600 hover:bg-green-500/20"
                              variant="secondary"
                            >
                              <Check className="mr-1 h-3 w-3" />
                              Downloaded
                            </Badge>
                          ) : (
                            <Button
                              className="h-7 w-7 p-0"
                              onClick={() => onDownload(model.id)}
                              size="sm"
                              variant="ghost"
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      )}
                      <Switch
                        checked={model.isEnabled}
                        onCheckedChange={(checked) => onToggle(model.id, checked)}
                      />
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          ))}
          {filteredModels.length === 0 && (
            <div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
              No models found matching your filters.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
