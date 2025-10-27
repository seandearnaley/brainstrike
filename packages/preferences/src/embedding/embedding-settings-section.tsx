import {
  listProviders,
  type ProviderDefinition,
  type ProviderModelDefinition,
} from '@brainstrike/agent/client';
import {
  type EmbeddingProviderType,
  ModelRegistryManager,
  STANDARD_EMBEDDING_DIMENSION,
} from '@brainstrike/embeddings';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@brainstrike/ui';
import { SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEmbeddingPreferencesStore } from '../stores/embedding-preferences-store';

type HostedEmbeddingProviderId = Exclude<EmbeddingProviderType, 'local'>;

type NormalizedEmbeddingModel = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly dimensions: number;
  readonly supportsStandardDimension: boolean;
  readonly supportsCustomDimensions: boolean;
  readonly availableDimensions?: readonly number[];
  readonly isDefault: boolean;
};

type NormalizedEmbeddingProvider = {
  readonly id: EmbeddingProviderType;
  readonly displayName: string;
  readonly runtime: 'browser' | 'hosted';
  readonly models: readonly NormalizedEmbeddingModel[];
  readonly pending?: boolean;
};

const HOSTED_PROVIDER_METADATA: Record<
  HostedEmbeddingProviderId,
  { readonly displayName: string; readonly runtime: 'hosted' }
> = {
  openai: { displayName: 'OpenAI', runtime: 'hosted' },
  google: { displayName: 'Google', runtime: 'hosted' },
  cohere: { displayName: 'Cohere', runtime: 'hosted' },
  voyage: { displayName: 'Voyage', runtime: 'hosted' },
};

const HOSTED_EMBEDDING_PROVIDER_IDS: readonly HostedEmbeddingProviderId[] = [
  'openai',
  'google',
  'cohere',
  'voyage',
] as const;

function normalizeLocalProvider(): NormalizedEmbeddingProvider {
  const registry = ModelRegistryManager.getRegistry();
  const defaultKey = ModelRegistryManager.getDefaultModelKey();

  const models = Object.entries(registry.models)
    .map<NormalizedEmbeddingModel>(([key, model]) => {
      const baseModel: NormalizedEmbeddingModel = {
        id: key,
        label: model.name ?? key,
        dimensions: model.dimensions,
        supportsStandardDimension: model.dimensions === STANDARD_EMBEDDING_DIMENSION,
        supportsCustomDimensions: false,
        isDefault: key === defaultKey,
      };

      if (model.description) {
        return {
          ...baseModel,
          description: model.description,
        };
      }

      return baseModel;
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    id: 'local',
    displayName: 'Local (Transformers.js)',
    runtime: 'browser',
    models,
  };
}

function toNormalizedHostedProvider(
  definition: ProviderDefinition,
  models: readonly (ProviderModelDefinition & { type: 'embedding' })[]
): NormalizedEmbeddingProvider {
  const normalizedModels = models
    .map<NormalizedEmbeddingModel>((model) => {
      const baseModel: NormalizedEmbeddingModel = {
        id: model.id,
        label: model.label ?? model.id,
        dimensions: model.defaultDimension ?? STANDARD_EMBEDDING_DIMENSION,
        supportsStandardDimension: model.supportsStandardDimension ?? false,
        supportsCustomDimensions: model.supportsCustomDimensions ?? false,
        isDefault: Boolean(model.default),
      };
      let enrichedModel: NormalizedEmbeddingModel = baseModel;
      if ('availableDimensions' in model) {
        const dims = (model as { availableDimensions?: readonly number[] }).availableDimensions;
        if (Array.isArray(dims) && dims.length > 0) {
          enrichedModel = {
            ...enrichedModel,
            availableDimensions: dims,
          };
        }
      }
      if ('description' in model && typeof model.description === 'string' && model.description) {
        enrichedModel = {
          ...enrichedModel,
          description: model.description,
        };
      }
      return enrichedModel;
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    id: definition.id as HostedEmbeddingProviderId,
    displayName: definition.displayName,
    runtime: definition.runtime === 'browser' ? 'browser' : 'hosted',
    models: normalizedModels,
  };
}

function placeholderHostedProvider(id: HostedEmbeddingProviderId): NormalizedEmbeddingProvider {
  return {
    id,
    displayName: HOSTED_PROVIDER_METADATA[id].displayName,
    runtime: HOSTED_PROVIDER_METADATA[id].runtime,
    models: [],
    pending: true,
  };
}

function buildEmbeddingProviders(): readonly NormalizedEmbeddingProvider[] {
  const providerDefinitions = listProviders();
  const providersById = new Map<string, ProviderDefinition>(
    providerDefinitions.map((definition: ProviderDefinition) => [definition.id, definition])
  );

  const localProvider = normalizeLocalProvider();

  const hostedProviders = HOSTED_EMBEDDING_PROVIDER_IDS.map((providerId) => {
    if (!providersById.has(providerId)) {
      return placeholderHostedProvider(providerId);
    }

    const definition = providersById.get(providerId);
    if (!definition) {
      return placeholderHostedProvider(providerId);
    }

    const embeddingModels = definition.models.filter(
      (model: ProviderModelDefinition): model is ProviderModelDefinition & { type: 'embedding' } =>
        model.type === 'embedding'
    );

    if (embeddingModels.length === 0) {
      return placeholderHostedProvider(providerId);
    }

    return toNormalizedHostedProvider(definition, embeddingModels);
  });

  return [localProvider, ...hostedProviders];
}

function parseCompositeKey(
  composite: string | null
): { provider: EmbeddingProviderType; modelId: string } | null {
  if (!composite) {
    return null;
  }
  const [provider, modelId] = composite.split('::');
  if (!provider || !modelId) {
    return null;
  }
  return {
    provider: provider as EmbeddingProviderType,
    modelId,
  };
}

export function EmbeddingSettings() {
  const providers = useMemo(buildEmbeddingProviders, []);
  const providersById = useMemo(
    () =>
      providers.reduce<Record<EmbeddingProviderType, NormalizedEmbeddingProvider>>(
        (acc, provider) => {
          acc[provider.id] = provider;
          return acc;
        },
        {} as Record<EmbeddingProviderType, NormalizedEmbeddingProvider>
      ),
    [providers]
  );

  const selectedModel = useEmbeddingPreferencesStore((state) => state.selectedModel);
  const enabledModelsByProvider = useEmbeddingPreferencesStore(
    (state) => state.enabledModelsByProvider
  );
  const setModel = useEmbeddingPreferencesStore((state) => state.setModel);
  const clearModel = useEmbeddingPreferencesStore((state) => state.clearModel);
  const setModelEnabled = useEmbeddingPreferencesStore((state) => state.setModelEnabled);
  const setProviderModelsEnabled = useEmbeddingPreferencesStore(
    (state) => state.setProviderModelsEnabled
  );

  const [searchTerm, setSearchTerm] = useState('');
  const normalizedSearch = searchTerm.trim().toLowerCase();

  const enabledOptions = useMemo(() => {
    return providers
      .map((provider) => {
        const enabledModels = new Set(enabledModelsByProvider[provider.id] ?? []);
        const options = provider.models.filter((model) => enabledModels.has(model.id));
        if (options.length === 0) {
          return null;
        }
        return {
          provider,
          options,
        };
      })
      .filter(
        (
          value
        ): value is {
          provider: NormalizedEmbeddingProvider;
          options: NormalizedEmbeddingModel[];
        } => value !== null
      );
  }, [enabledModelsByProvider, providers]);

  const selectedLabel = useMemo(() => {
    const parsed = parseCompositeKey(selectedModel);
    if (!parsed) {
      return null;
    }
    const provider = providersById[parsed.provider];
    const model = provider?.models.find((item) => item.id === parsed.modelId);
    if (!provider || !model) {
      return null;
    }
    return `${provider.displayName} · ${model.label}`;
  }, [providersById, selectedModel]);

  const handleSelectChange = (value: string) => {
    if (!value) {
      clearModel();
      return;
    }
    setModel(value);
  };

  const resetToDefault = () => {
    const localProvider = providersById.local;
    const defaultModel = localProvider.models.find((model) => model.isDefault);
    if (!defaultModel) {
      clearModel();
      return;
    }
    const composite = `local::${defaultModel.id}`;
    const enabledSet = new Set(enabledModelsByProvider.local ?? []);
    if (!enabledSet.has(defaultModel.id)) {
      setModelEnabled('local', defaultModel.id, true);
    }
    setModel(composite);
  };

  const hasEnabledSelection = enabledOptions.length > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Embedding Model</CardTitle>
          <CardDescription>
            Select the embedding model used for indexing, semantic search, and import jobs. Models
            must emit {STANDARD_EMBEDDING_DIMENSION} dimensional vectors to stay compatible with the
            current database schema.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="embedding-model-select">Active model</Label>
            <Select value={selectedModel ?? ''} onValueChange={handleSelectChange}>
              <SelectTrigger
                id="embedding-model-select"
                data-testid="embedding-model-select"
                disabled={!hasEnabledSelection}
              >
                <SelectValue placeholder="Select embedding model" />
              </SelectTrigger>
              <SelectContent>
                {enabledOptions.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    Enable a model below to select it
                  </div>
                ) : (
                  enabledOptions.map(({ provider, options }) => (
                    <SelectGroup key={provider.id}>
                      <SelectLabel>{provider.displayName}</SelectLabel>
                      {options.map((model) => {
                        const composite = `${provider.id}::${model.id}`;
                        return (
                          <SelectItem key={composite} value={composite}>
                            {model.label}
                            {model.supportsStandardDimension ? (
                              <Badge variant="secondary" className="ml-2">
                                {STANDARD_EMBEDDING_DIMENSION}D
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="ml-2">
                                Non-{STANDARD_EMBEDDING_DIMENSION}D
                              </Badge>
                            )}
                          </SelectItem>
                        );
                      })}
                    </SelectGroup>
                  ))
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground" data-testid="embedding-model-summary">
              {selectedLabel ?? 'No model selected'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={resetToDefault}
              data-testid="embedding-reset-default"
            >
              Reset to recommended default
            </Button>
            {hasEnabledSelection ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => clearModel()}
                data-testid="embedding-clear-selection"
              >
                Clear selection
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model Availability</CardTitle>
          <CardDescription>
            Enable models before exposing them to import workflows. Toggle availability per provider
            and track which models satisfy the {STANDARD_EMBEDDING_DIMENSION}D requirement.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Input
                aria-label="Search embedding models"
                placeholder="Search embedding models"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.currentTarget.value)}
                className="pl-9"
              />
              <SearchIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <div className="space-y-3">
            {providers.map((provider) => {
              if (provider.pending) {
                return <PendingProviderSection key={provider.id} provider={provider} />;
              }

              if (provider.models.length === 0) {
                return <EmptyProviderSection key={provider.id} provider={provider} />;
              }

              const enabledSet = new Set(enabledModelsByProvider[provider.id] ?? []);

              const visibleModels = normalizedSearch
                ? provider.models.filter((model) => {
                    const haystack = `${model.label} ${model.id}`.toLowerCase();
                    return haystack.includes(normalizedSearch);
                  })
                : provider.models;

              if (visibleModels.length === 0) {
                return null;
              }

              const modelIds = provider.models.map((model) => model.id);

              const totalModels = provider.models.length;
              const enabledCount = provider.models.reduce(
                (count, model) => count + (enabledSet.has(model.id) ? 1 : 0),
                0
              );

              return (
                <section
                  key={provider.id}
                  className="rounded-lg border border-border/60 bg-muted/10"
                  data-testid={`embedding-provider-${provider.id}`}
                >
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                    <div>
                      <p className="text-sm font-medium leading-tight">{provider.displayName}</p>
                      <p className="text-xs text-muted-foreground">
                        {enabledCount} of {totalModels} models enabled
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={provider.runtime === 'browser' ? 'secondary' : 'outline'}>
                        {provider.runtime === 'browser' ? 'Browser' : 'Hosted'}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setProviderModelsEnabled(provider.id, modelIds, true)}
                        disabled={enabledCount === totalModels}
                        data-testid={`embedding-enable-all-${provider.id}`}
                      >
                        Enable all
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setProviderModelsEnabled(provider.id, modelIds, false)}
                        disabled={enabledCount === 0}
                        data-testid={`embedding-disable-all-${provider.id}`}
                      >
                        Disable all
                      </Button>
                    </div>
                  </header>
                  <div className="space-y-2 px-3 py-3">
                    {visibleModels.map((model) => (
                      <EmbeddingModelRow
                        key={model.id}
                        providerId={provider.id}
                        model={model}
                        enabled={enabledSet.has(model.id)}
                        onToggle={(next) => setModelEnabled(provider.id, model.id, next)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            {providers.every((provider) => provider.pending || provider.models.length === 0) ? (
              <p className="text-xs text-muted-foreground">
                Hosted provider integrations are on the roadmap. Local embeddings remain available.
              </p>
            ) : null}
            {normalizedSearch &&
            providers.every((provider) => {
              if (provider.pending || provider.models.length === 0) {
                return true;
              }
              return provider.models.every((model) => {
                const haystack = `${model.label} ${model.id}`.toLowerCase();
                return !haystack.includes(normalizedSearch);
              });
            }) ? (
              <p className="text-xs text-muted-foreground">
                No embedding models match &quot;{searchTerm}&quot;.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface EmbeddingModelRowProps {
  providerId: EmbeddingProviderType;
  model: NormalizedEmbeddingModel;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

function EmbeddingModelRow({ providerId, model, enabled, onToggle }: EmbeddingModelRowProps) {
  const handleChange = (checked: boolean) => {
    onToggle(checked);
  };

  return (
    <div
      className={
        'flex flex-col gap-2 rounded-md border border-border/60 bg-background px-3 py-3 md:flex-row md:items-center md:justify-between'
      }
      data-testid={`embedding-model-row-${providerId}-${model.id}`}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium leading-tight">{model.label}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{model.id}</span>
          <span>{model.dimensions}D</span>
          {model.supportsCustomDimensions ? <span>Custom dimensions supported</span> : null}
          {model.isDefault ? <Badge variant="outline">Default</Badge> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {model.supportsStandardDimension ? (
          <Badge variant="secondary">{STANDARD_EMBEDDING_DIMENSION}D ready</Badge>
        ) : (
          <Badge variant="destructive">Dimension mismatch</Badge>
        )}
        <Switch
          checked={enabled}
          onCheckedChange={handleChange}
          aria-label={`Enable ${model.label}`}
          data-testid={`embedding-toggle-${providerId}-${model.id}`}
        />
      </div>
    </div>
  );
}

interface PendingProviderSectionProps {
  provider: NormalizedEmbeddingProvider;
}

function PendingProviderSection({ provider }: PendingProviderSectionProps) {
  const metadata = HOSTED_PROVIDER_METADATA[provider.id as HostedEmbeddingProviderId];
  return (
    <section
      className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-3"
      data-testid={`embedding-provider-${provider.id}-pending`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium leading-tight">{metadata.displayName}</p>
          <p className="text-xs text-muted-foreground">
            Hosted embedding integration coming soon. Configure API keys in the Provider Keys
            section to prepare for launch.
          </p>
        </div>
        <Badge variant="outline">
          {metadata.runtime === 'hosted' ? 'Hosted' : metadata.runtime}
        </Badge>
      </div>
    </section>
  );
}

interface EmptyProviderSectionProps {
  provider: NormalizedEmbeddingProvider;
}

function EmptyProviderSection({ provider }: EmptyProviderSectionProps) {
  const metadata = HOSTED_PROVIDER_METADATA[provider.id as HostedEmbeddingProviderId];
  return (
    <section
      className="rounded-lg border border-border/60 bg-muted/10 px-3 py-3"
      data-testid={`embedding-provider-${provider.id}-empty`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium leading-tight">{metadata.displayName}</p>
          <p className="text-xs text-muted-foreground">
            This provider does not currently expose embedding models in the shared registry.
          </p>
        </div>
        <Badge variant="outline">
          {metadata.runtime === 'hosted' ? 'Hosted' : metadata.runtime}
        </Badge>
      </div>
    </section>
  );
}
