import {
  listProviders,
  type ProviderDefinition,
  type ProviderModelDefinition,
} from '@brainstrike/agent/client';
import { CHUNKING_CONFIG } from '@brainstrike/db';
import {
  type EmbeddingProviderType,
  type HostedProviderType,
  isLocalProviderType,
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
  Switch,
} from '@brainstrike/ui';
import { SearchIcon } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useEnsureModelRegistry } from '../hooks/use-model-registry';
import { useEmbeddingPreferencesStore } from '../stores/embedding-preferences-store';
import type { DbModel, DbProvider } from '../stores/model-registry-store';
import { useModelRegistryStore } from '../stores/model-registry-store';

type HostedEmbeddingProviderId = HostedProviderType;

type ModelPreset = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly provider: EmbeddingProviderType;
  readonly modelId: string;
  readonly badge: string;
  readonly icon: '🎯' | '💰' | '🌍';
};

const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'high-accuracy',
    name: 'High Accuracy',
    description: 'Best performance for semantic search and retrieval (Voyage AI)',
    provider: 'voyage',
    modelId: 'voyage-3',
    badge: '1024D',
    icon: '🎯',
  },
  {
    id: 'cost-optimized',
    name: 'Cost Optimized',
    description: 'Balanced performance and cost-effectiveness (OpenAI)',
    provider: 'openai',
    modelId: 'text-embedding-3-small',
    badge: '1536D',
    icon: '💰',
  },
  {
    id: 'multilingual',
    name: 'Multilingual',
    description: 'Optimized for 100+ languages and cross-lingual search (Cohere)',
    provider: 'cohere',
    modelId: 'embed-multilingual-v3.0',
    badge: '1024D',
    icon: '🌍',
  },
] as const;

type CodeChunkRow = {
  key: keyof typeof CHUNKING_CONFIG.codeLanguageDefaults;
  label: string;
  extensions: string;
};

const CODE_CHUNK_ROWS: readonly CodeChunkRow[] = [
  { key: 'typescript', label: 'TypeScript', extensions: 'ts, tsx, mts, cts' },
  { key: 'javascript', label: 'JavaScript', extensions: 'js, jsx, mjs, cjs' },
  { key: 'python', label: 'Python', extensions: 'py' },
  { key: 'rust', label: 'Rust', extensions: 'rs' },
  { key: 'go', label: 'Go', extensions: 'go' },
  { key: 'java', label: 'Java', extensions: 'java' },
  { key: 'csharp', label: 'C#', extensions: 'cs' },
  { key: 'cpp', label: 'C / C++', extensions: 'c, cc, cpp, h, hpp' },
  { key: 'ruby', label: 'Ruby', extensions: 'rb' },
  { key: 'php', label: 'PHP', extensions: 'php' },
  { key: 'swift', label: 'Swift', extensions: 'swift' },
  { key: 'kotlin', label: 'Kotlin', extensions: 'kt, kts' },
] as const;

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

function resolveLocalModelDimensions(model: DbModel): number {
  const dimensions = Number(model.capabilities.defaultDimension);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(`Local embedding model "${model.id}" has invalid dimensions.`);
  }
  return dimensions;
}

function getLocalProviderDisplayName(providers: DbProvider[]): string {
  const localProvider = providers.find((provider) =>
    isLocalProviderType(provider.id as EmbeddingProviderType)
  );
  return localProvider?.name ?? 'Local (Transformers.js)';
}

function buildLocalProvider(
  models: DbModel[],
  providers: DbProvider[],
  pending: boolean
): NormalizedEmbeddingProvider {
  const localModels = models
    .filter((model) => isLocalProviderType(model.providerId as EmbeddingProviderType))
    .filter((model) => model.capabilities.type === 'embedding')
    .map<NormalizedEmbeddingModel>((model) => {
      const dimensions = resolveLocalModelDimensions(model);
      const baseModel: NormalizedEmbeddingModel = {
        id: model.id,
        label: model.name ?? model.id,
        dimensions,
        supportsStandardDimension: dimensions === STANDARD_EMBEDDING_DIMENSION,
        supportsCustomDimensions: false,
        isDefault: false,
      };

      const description = model.description ?? model.tagline;
      if (description) {
        return {
          ...baseModel,
          description,
        };
      }

      return baseModel;
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    id: 'local',
    displayName: getLocalProviderDisplayName(providers),
    runtime: 'browser',
    models: localModels,
    ...(pending ? { pending: true } : {}),
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

function buildEmbeddingProviders(
  models: DbModel[],
  registryProviders: DbProvider[],
  localPending: boolean
): readonly NormalizedEmbeddingProvider[] {
  const providerDefinitions = listProviders();
  const providersById = new Map<string, ProviderDefinition>(
    providerDefinitions.map((definition: ProviderDefinition) => [definition.id, definition])
  );

  const localProvider = buildLocalProvider(models, registryProviders, localPending);

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

type EnabledModelsByProvider = Partial<Record<EmbeddingProviderType, string[]>>;

function getEnabledSet(
  enabledModelsByProvider: EnabledModelsByProvider,
  providerId: EmbeddingProviderType
): Set<string> {
  return new Set(enabledModelsByProvider[providerId] ?? []);
}

function filterVisibleModels(
  models: readonly NormalizedEmbeddingModel[],
  normalizedSearch: string
): readonly NormalizedEmbeddingModel[] {
  if (!normalizedSearch) {
    return models;
  }
  return models.filter((model) => {
    const haystack = `${model.label} ${model.id}`.toLowerCase();
    return haystack.includes(normalizedSearch);
  });
}

type ProviderSectionContext = {
  provider: NormalizedEmbeddingProvider;
  enabledModelsByProvider: EnabledModelsByProvider;
  normalizedSearch: string;
  setModelEnabled: (provider: EmbeddingProviderType, model: string, enabled: boolean) => void;
  setProviderModelsEnabled: (
    provider: EmbeddingProviderType,
    models: readonly string[],
    enabled: boolean
  ) => void;
};

function renderProviderSection({
  provider,
  enabledModelsByProvider,
  normalizedSearch,
  setModelEnabled,
  setProviderModelsEnabled,
}: ProviderSectionContext): ReactElement | null {
  if (provider.id === 'local') {
    if (provider.pending) {
      return <LocalPendingSection key={provider.id} provider={provider} />;
    }
    if (provider.models.length === 0) {
      return <LocalEmptySection key={provider.id} provider={provider} />;
    }
  }

  if (provider.pending) {
    return <PendingProviderSection key={provider.id} provider={provider} />;
  }

  if (provider.models.length === 0) {
    return <EmptyProviderSection key={provider.id} provider={provider} />;
  }

  const enabledSet = getEnabledSet(enabledModelsByProvider, provider.id);
  const visibleModels = filterVisibleModels(provider.models, normalizedSearch);

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
      className="rounded-lg border border-border/60 bg-muted/10"
      data-testid={`embedding-provider-${provider.id}`}
      key={provider.id}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-border/60 border-b px-3 py-2">
        <div>
          <p className="font-medium text-sm leading-tight">{provider.displayName}</p>
          <p className="text-muted-foreground text-xs">
            {enabledCount} of {totalModels} models enabled
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={provider.runtime === 'browser' ? 'secondary' : 'outline'}>
            {provider.runtime === 'browser' ? 'Browser' : 'Hosted'}
          </Badge>
          <Button
            data-testid={`embedding-enable-all-${provider.id}`}
            disabled={enabledCount === totalModels}
            onClick={() => setProviderModelsEnabled(provider.id, modelIds, true)}
            size="sm"
            variant="outline"
          >
            Enable all
          </Button>
          <Button
            data-testid={`embedding-disable-all-${provider.id}`}
            disabled={enabledCount === 0}
            onClick={() => setProviderModelsEnabled(provider.id, modelIds, false)}
            size="sm"
            variant="ghost"
          >
            Disable all
          </Button>
        </div>
      </header>
      <div className="space-y-2 px-3 py-3">
        {visibleModels.map((model) => (
          <EmbeddingModelRow
            enabled={enabledSet.has(model.id)}
            key={model.id}
            model={model}
            onToggle={(next) => setModelEnabled(provider.id, model.id, next)}
            providerId={provider.id}
          />
        ))}
      </div>
    </section>
  );
}

// parseCompositeKey removed - selection is now per-collection/embedding-set, not a global preference.

export function EmbeddingSettings() {
  const { models, providers: registryProviders, isLoading, hasLoaded } = useModelRegistryStore();
  const registryError = useEnsureModelRegistry();
  const localPending = isLoading && !hasLoaded && models.length === 0;
  const providers = useMemo(
    () => buildEmbeddingProviders(models, registryProviders, localPending),
    [localPending, models, registryProviders]
  );

  const enabledModelsByProvider = useEmbeddingPreferencesStore(
    (state) => state.enabledModelsByProvider
  );
  const setModelEnabled = useEmbeddingPreferencesStore((state) => state.setModelEnabled);
  const setProviderModelsEnabled = useEmbeddingPreferencesStore(
    (state) => state.setProviderModelsEnabled
  );

  const [searchTerm, setSearchTerm] = useState('');
  const normalizedSearch = searchTerm.trim().toLowerCase();

  // enabledOptions removed (selection UI removed); we keep enabledModelsByProvider for rendering availability.

  const applyPreset = (preset: ModelPreset) => {
    const enabledSet = new Set(enabledModelsByProvider[preset.provider] ?? []);
    // Enable the model if it's not already enabled
    if (!enabledSet.has(preset.modelId)) {
      setModelEnabled(preset.provider, preset.modelId, true);
    }
  };

  // whether any enabled models exist (kept for potential UI decisions)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Start Presets</CardTitle>
          <CardDescription>
            Choose a preset configuration optimized for common use cases. Each preset automatically
            enables and selects the recommended model.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            {MODEL_PRESETS.map((preset) => (
              <button
                className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background p-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                data-testid={`preset-${preset.id}`}
                key={preset.id}
                onClick={() => applyPreset(preset)}
                type="button"
              >
                <div className="flex items-start justify-between">
                  <span aria-hidden="true" className="text-2xl">
                    {preset.icon}
                  </span>
                  <Badge className="text-[10px]" variant="outline">
                    {preset.badge}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-sm leading-tight">{preset.name}</p>
                  <p className="text-muted-foreground text-xs">{preset.description}</p>
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Active model selection removed: models are selected per-collection/embedding-set */}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model Availability</CardTitle>
          <CardDescription>
            Enable models before exposing them to import workflows. Toggle availability per provider
            and view dimension information for each model.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Input
                aria-label="Search embedding models"
                className="pl-9"
                onChange={(event) => setSearchTerm(event.currentTarget.value)}
                placeholder="Search embedding models"
                value={searchTerm}
              />
              <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2.5 h-4 w-4 text-muted-foreground" />
            </div>
          </div>

          <div className="space-y-3">
            {registryError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
                <p className="font-medium text-sm">Failed to load model registry</p>
                <p className="text-xs">{registryError}</p>
              </div>
            ) : null}
            {providers.map((provider) =>
              renderProviderSection({
                provider,
                enabledModelsByProvider,
                normalizedSearch,
                setModelEnabled,
                setProviderModelsEnabled,
              })
            )}
            {providers.every((provider) => provider.pending || provider.models.length === 0) ? (
              <p className="text-muted-foreground text-xs">
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
              <p className="text-muted-foreground text-xs">
                No embedding models match &quot;{searchTerm}&quot;.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card data-testid="code-chunking-card">
        <CardHeader>
          <CardTitle className="text-base">Code Chunking</CardTitle>
          <CardDescription>
            Language-aware defaults used when splitting source files for embeddings. JavaScript and
            TypeScript use AST-aware function boundaries; other languages fall back to token-based
            chunking.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CODE_CHUNK_ROWS.map((row) => {
              const defaults = CHUNKING_CONFIG.codeLanguageDefaults[row.key];
              return (
                <div
                  className="rounded-md border border-border/60 bg-muted/10 px-3 py-2"
                  data-testid={`code-chunk-row-${row.key}`}
                  key={row.key}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm leading-tight">{row.label}</p>
                      <p className="text-[11px] text-muted-foreground">{row.extensions}</p>
                    </div>
                    <Badge variant="outline">{defaults.maxTokens} tok</Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Overlap {defaults.overlap} tokens
                  </p>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            These defaults apply automatically during import; overrides are still subject to global
            safety caps.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

type EmbeddingModelRowProps = {
  providerId: EmbeddingProviderType;
  model: NormalizedEmbeddingModel;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
};

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
        <p className="font-medium text-sm leading-tight">{model.label}</p>
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <span>{model.id}</span>
          <span>{model.dimensions}D</span>
          {model.supportsCustomDimensions ? <span>Custom dimensions supported</span> : null}
          {model.isDefault ? <Badge variant="outline">Default</Badge> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={model.dimensions === 768 ? 'secondary' : 'outline'}>
          {model.dimensions}D
        </Badge>
        <Switch
          aria-label={`Enable ${model.label}`}
          checked={enabled}
          data-testid={`embedding-toggle-${providerId}-${model.id}`}
          onCheckedChange={handleChange}
        />
      </div>
    </div>
  );
}

type PendingProviderSectionProps = {
  provider: NormalizedEmbeddingProvider;
};

function LocalPendingSection({ provider }: PendingProviderSectionProps) {
  return (
    <section
      className="rounded-lg border border-border/60 border-dashed bg-muted/20 px-3 py-3"
      data-testid={`embedding-provider-${provider.id}-pending`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium text-sm leading-tight">{provider.displayName}</p>
          <p className="text-muted-foreground text-xs">
            Loading local embedding models from the registry.
          </p>
        </div>
        <Badge variant="outline">Browser</Badge>
      </div>
    </section>
  );
}

function PendingProviderSection({ provider }: PendingProviderSectionProps) {
  const metadata = HOSTED_PROVIDER_METADATA[provider.id as HostedEmbeddingProviderId];
  return (
    <section
      className="rounded-lg border border-border/60 border-dashed bg-muted/20 px-3 py-3"
      data-testid={`embedding-provider-${provider.id}-pending`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium text-sm leading-tight">{metadata.displayName}</p>
          <p className="text-muted-foreground text-xs">
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

type EmptyProviderSectionProps = {
  provider: NormalizedEmbeddingProvider;
};

function LocalEmptySection({ provider }: EmptyProviderSectionProps) {
  return (
    <section
      className="rounded-lg border border-border/60 bg-muted/10 px-3 py-3"
      data-testid={`embedding-provider-${provider.id}-empty`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium text-sm leading-tight">{provider.displayName}</p>
          <p className="text-muted-foreground text-xs">
            No local embedding models are available in the registry. Check Settings &gt; Models to
            refresh or enable local entries.
          </p>
        </div>
        <Badge variant="outline">Browser</Badge>
      </div>
    </section>
  );
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
          <p className="font-medium text-sm leading-tight">{metadata.displayName}</p>
          <p className="text-muted-foreground text-xs">
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
