import {
  isLoadedRuntimeModelCatalogState,
  type LoadedRuntimeModelCatalogState,
  type LocalRuntimeId,
  type LocalRuntimeModelCatalogState,
} from '@brainstrike/agent/local-runtime';
import {
  listProviders,
  type ProviderDefinition,
  type ProviderModelDefinition,
} from '@brainstrike/assistant-contract/provider-metadata';
import { CHUNKING_CONFIG } from '@brainstrike/db';
import {
  type EmbeddingProviderType,
  type HostedProviderType,
  isLocalProviderType,
  STANDARD_EMBEDDING_DIMENSION,
} from '@brainstrike/embeddings/provider-core';
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
import { defaultCollator } from '@brainstrike/utils/collator';
import { SearchIcon } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useLocalRuntimeEmbeddingModelCatalog } from '../hooks/use-local-runtime-embedding-model-catalog';
import { useEnsureModelRegistry } from '../hooks/use-model-registry';
import { useEmbeddingPreferencesStore } from '../stores/embedding-preferences-store';
import type { DbModel, DbProvider } from '../stores/model-registry-store';
import { useModelRegistryStore } from '../stores/model-registry-store';

type HostedEmbeddingProviderId = HostedProviderType;
type LocalRuntimeModelCatalogMap = Partial<Record<LocalRuntimeId, LocalRuntimeModelCatalogState>>;

interface ModelPreset {
  readonly badge: string;
  readonly description: string;
  readonly icon: '🎯' | '💰' | '🌍';
  readonly id: string;
  readonly modelId: string;
  readonly name: string;
  readonly provider: EmbeddingProviderType;
}

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

interface CodeChunkRow {
  extensions: string;
  key: keyof typeof CHUNKING_CONFIG.codeLanguageDefaults;
  label: string;
}

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

interface NormalizedEmbeddingModel {
  readonly availableDimensions?: readonly number[];
  readonly description?: string;
  readonly dimensions: number;
  readonly id: string;
  readonly isDefault: boolean;
  readonly label: string;
  readonly supportsCustomDimensions: boolean;
  readonly supportsStandardDimension: boolean;
}

interface NormalizedEmbeddingProvider {
  readonly displayName: string;
  readonly id: EmbeddingProviderType;
  readonly models: readonly NormalizedEmbeddingModel[];
  readonly pending?: boolean;
  readonly runtime: 'browser' | 'hosted';
}

const HOSTED_PROVIDER_METADATA: Record<
  HostedEmbeddingProviderId,
  { readonly displayName: string; readonly runtime: 'hosted' }
> = {
  openai: { displayName: 'OpenAI', runtime: 'hosted' },
  google: { displayName: 'Google', runtime: 'hosted' },
  cohere: { displayName: 'Cohere', runtime: 'hosted' },
  voyage: { displayName: 'Voyage', runtime: 'hosted' },
  ollama: { displayName: 'Ollama', runtime: 'hosted' },
  lmstudio: { displayName: 'LM Studio', runtime: 'hosted' },
};

const HOSTED_EMBEDDING_PROVIDER_IDS: readonly HostedEmbeddingProviderId[] = [
  'openai',
  'google',
  'cohere',
  'voyage',
  'ollama',
  'lmstudio',
] as const;

const LOCAL_RUNTIME_PROVIDER_IDS: readonly LocalRuntimeId[] = ['ollama', 'lmstudio'] as const;
const LOCAL_RUNTIME_PROVIDER_METADATA: Record<
  LocalRuntimeId,
  { readonly displayName: string; readonly runtime: 'hosted' }
> = {
  ollama: HOSTED_PROVIDER_METADATA.ollama,
  lmstudio: HOSTED_PROVIDER_METADATA.lmstudio,
} as const;

function isRuntimeHostedProvider(
  providerId: HostedEmbeddingProviderId
): providerId is LocalRuntimeId {
  return LOCAL_RUNTIME_PROVIDER_IDS.includes(providerId as LocalRuntimeId);
}

function resolveKnownRuntimeDimensions(
  model: LoadedRuntimeModelCatalogState['models'][number]
): readonly number[] {
  if (model.dimensionsKnown.state !== 'known') {
    return [];
  }
  return model.dimensionsKnown.values.filter(
    (value: number) => Number.isFinite(value) && value > 0
  );
}

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
    .sort((a, b) => defaultCollator.compare(a.label, b.label));

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
    .sort((a, b) => defaultCollator.compare(a.label, b.label));

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

function toNormalizedRuntimeProvider(
  providerId: LocalRuntimeId,
  state: LocalRuntimeModelCatalogState
): NormalizedEmbeddingProvider {
  const providerMetadata = LOCAL_RUNTIME_PROVIDER_METADATA[providerId];
  if (!providerMetadata) {
    // Fail fast so new runtime ids cannot silently drift from their metadata mapping.
    throw new Error(`Unknown local runtime provider: ${providerId}`);
  }

  const models = isLoadedRuntimeModelCatalogState(state)
    ? state.models
        .filter(
          (model: LoadedRuntimeModelCatalogState['models'][number]) =>
            model.capabilities.embeddings !== 'unsupported'
        )
        .map<NormalizedEmbeddingModel>(
          (model: LoadedRuntimeModelCatalogState['models'][number]) => {
            const knownDimensions = resolveKnownRuntimeDimensions(model);
            const dimensions = knownDimensions[0] ?? STANDARD_EMBEDDING_DIMENSION;
            const hasKnownDimensions = knownDimensions.length > 0;
            const descriptionParts: string[] = [];
            if (model.displayName !== model.modelId) {
              descriptionParts.push(model.displayName);
            }
            if (!hasKnownDimensions) {
              descriptionParts.push('Dimension pending verification');
            }
            if (state.state === 'stale_cached') {
              descriptionParts.push('Using cached runtime model list');
            }

            return {
              id: model.modelId,
              label: model.displayName,
              dimensions,
              supportsStandardDimension: hasKnownDimensions
                ? knownDimensions.includes(STANDARD_EMBEDDING_DIMENSION)
                : dimensions === STANDARD_EMBEDDING_DIMENSION,
              supportsCustomDimensions: false,
              ...(hasKnownDimensions ? { availableDimensions: knownDimensions } : {}),
              ...(descriptionParts.length > 0 ? { description: descriptionParts.join(' • ') } : {}),
              isDefault: false,
            };
          }
        )
        .sort((a: NormalizedEmbeddingModel, b: NormalizedEmbeddingModel) =>
          defaultCollator.compare(a.label, b.label)
        )
        .map((model: NormalizedEmbeddingModel, index: number) => ({
          ...model,
          isDefault: index === 0,
        }))
    : [];

  return {
    id: providerId,
    displayName: providerMetadata.displayName,
    runtime: providerMetadata.runtime,
    models,
  };
}

function buildEmbeddingProviders(
  models: DbModel[],
  registryProviders: DbProvider[],
  localPending: boolean,
  runtimeCatalog: LocalRuntimeModelCatalogMap | null,
  runtimeCatalogLoading: boolean
): readonly NormalizedEmbeddingProvider[] {
  const providerDefinitions = listProviders();
  const providersById = new Map<string, ProviderDefinition>(
    providerDefinitions.map((definition: ProviderDefinition) => [definition.id, definition])
  );

  const localProvider = buildLocalProvider(models, registryProviders, localPending);

  const hostedProviders = HOSTED_EMBEDDING_PROVIDER_IDS.map((providerId) => {
    if (isRuntimeHostedProvider(providerId)) {
      const state = runtimeCatalog?.[providerId];
      if (!state) {
        return runtimeCatalogLoading
          ? placeholderHostedProvider(providerId)
          : {
              id: providerId,
              displayName: HOSTED_PROVIDER_METADATA[providerId].displayName,
              runtime: HOSTED_PROVIDER_METADATA[providerId].runtime,
              models: [],
            };
      }
      return toNormalizedRuntimeProvider(providerId, state);
    }

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

interface ProviderSectionContext {
  enabledModelsByProvider: EnabledModelsByProvider;
  normalizedSearch: string;
  provider: NormalizedEmbeddingProvider;
  setModelEnabled: (provider: EmbeddingProviderType, model: string, enabled: boolean) => void;
  setProviderModelsEnabled: (
    provider: EmbeddingProviderType,
    models: readonly string[],
    enabled: boolean
  ) => void;
}

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
  const {
    catalog: runtimeCatalog,
    isLoading: runtimeCatalogLoading,
    error: runtimeCatalogError,
  } = useLocalRuntimeEmbeddingModelCatalog({
    verifyEmbeddingDimensions: true,
    maxVerificationModels: 8,
  });
  const localPending = isLoading && !hasLoaded && models.length === 0;
  const providers = useMemo(
    () =>
      buildEmbeddingProviders(
        models,
        registryProviders,
        localPending,
        runtimeCatalog,
        runtimeCatalogLoading
      ),
    [localPending, models, registryProviders, runtimeCatalog, runtimeCatalogLoading]
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
              <SearchIcon className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <div className="space-y-3">
            {registryError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
                <p className="font-medium text-sm">Failed to load model registry</p>
                <p className="text-xs">{registryError}</p>
              </div>
            ) : null}
            {runtimeCatalogError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
                <p className="font-medium text-sm">Failed to load local runtime models</p>
                <p className="text-xs">{runtimeCatalogError}</p>
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
                No hosted embedding models are currently available. Start Ollama or LM Studio to
                discover local runtime models.
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

interface EmbeddingModelRowProps {
  enabled: boolean;
  model: NormalizedEmbeddingModel;
  onToggle: (enabled: boolean) => void;
  providerId: EmbeddingProviderType;
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
        <p className="font-medium text-sm leading-tight">{model.label}</p>
        {model.description ? (
          <p className="text-muted-foreground text-xs">{model.description}</p>
        ) : null}
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

interface PendingProviderSectionProps {
  provider: NormalizedEmbeddingProvider;
}

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
  const runtimeProvider = isRuntimeHostedProvider(provider.id as HostedEmbeddingProviderId);
  return (
    <section
      className="rounded-lg border border-border/60 border-dashed bg-muted/20 px-3 py-3"
      data-testid={`embedding-provider-${provider.id}-pending`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium text-sm leading-tight">{metadata.displayName}</p>
          <p className="text-muted-foreground text-xs">
            {runtimeProvider
              ? 'Detecting locally available models from the runtime endpoint.'
              : 'Hosted embedding integration coming soon. Configure API keys in the Provider Keys section to prepare for launch.'}
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
  const runtimeProvider = isRuntimeHostedProvider(provider.id as HostedEmbeddingProviderId);
  return (
    <section
      className="rounded-lg border border-border/60 bg-muted/10 px-3 py-3"
      data-testid={`embedding-provider-${provider.id}-empty`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium text-sm leading-tight">{metadata.displayName}</p>
          <p className="text-muted-foreground text-xs">
            {runtimeProvider
              ? 'No embedding-capable runtime models were discovered with verified dimensions.'
              : 'This provider does not currently expose embedding models in the shared registry.'}
          </p>
        </div>
        <Badge variant="outline">
          {metadata.runtime === 'hosted' ? 'Hosted' : metadata.runtime}
        </Badge>
      </div>
    </section>
  );
}
