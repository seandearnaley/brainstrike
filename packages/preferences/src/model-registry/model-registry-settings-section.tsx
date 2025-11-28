import { usePGliteDatabase } from '@brainstrike/db';
import { Badge, Button, Card, Label, Switch } from '@brainstrike/ui';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useModelRegistryStore } from '../stores/model-registry-store';

export function ModelRegistrySettingsSection() {
  const db = usePGliteDatabase();
  const { providers, models, isLoading, error, fetchRegistry, toggleProvider, toggleModel } =
    useModelRegistryStore();
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
              <div className="p-4 flex items-center gap-4">
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
                <div className="border-t border-border bg-muted/30 px-4 py-2 space-y-1">
                  {providerModels.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2 px-8">No models found.</p>
                  ) : (
                    providerModels.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center justify-between py-2 pl-10 pr-2 rounded-md hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{model.name}</span>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{model.id}</span>
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
                        </div>
                        <Switch
                          checked={model.isEnabled}
                          disabled={!provider.isEnabled}
                          onCheckedChange={(checked) => db && toggleModel(db, model.id, checked)}
                          aria-label={`Enable ${model.name}`}
                        />
                      </div>
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
