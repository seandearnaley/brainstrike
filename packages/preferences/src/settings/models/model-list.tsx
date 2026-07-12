import {
  Badge,
  Button,
  Card,
  cn,
  Input,
  ScrollArea,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { Check, Download, Loader2, Search, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DbModel, DbProvider } from '../../stores/model-registry-store';

const LOCAL_PROVIDER_IDS = new Set<string>(['local', 'transformers']);
const numberFormatter = new Intl.NumberFormat();

interface ModelListProps {
  downloadedModels: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  isDownloading: Record<string, boolean>;
  modelCacheDir?: string | null;
  models: DbModel[];
  onDownload: (modelId: string) => void;
  onToggle: (modelId: string, enabled: boolean) => void;
  pendingModelIds?: ReadonlySet<string>;
  providers: DbProvider[];
}

type ModelCategory = 'chat' | 'embedding';
type ModelTier = 'local' | 'remote';

interface ProviderGroup {
  id: string;
  models: DbModel[];
  name: string;
}

interface ModelSection {
  description: string;
  groups: ProviderGroup[];
  id: ModelTier;
  modelsCount: number;
  title: string;
}

interface ModelRowProps {
  downloadedModels: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  isDownloading: Record<string, boolean>;
  model: DbModel;
  modelCacheDir: string | null;
  onDownload: (modelId: string) => void;
  onToggle: (modelId: string, enabled: boolean) => void;
  pendingModelIds: ReadonlySet<string>;
}

interface ModelMetaBadgesProps {
  dimensionLabel: string | null;
  model: DbModel;
  sizeLabel: string | null;
}

interface ModelBestForTagsProps {
  modelId: string;
  tags: string[];
}

interface ModelCachePathProps {
  downloadedModels: Record<string, boolean>;
  isLocal: boolean;
  modelCacheDir: string | null;
  modelId: string;
}

interface ModelDownloadProgressProps {
  downloadProgress: Record<string, number>;
  isDownloading: Record<string, boolean>;
  isLocal: boolean;
  modelId: string;
}

interface ModelDownloadControlsProps {
  downloadedModels: Record<string, boolean>;
  isDownloading: Record<string, boolean>;
  isLocal: boolean;
  modelId: string;
  onDownload: (modelId: string) => void;
}

function isLocalProviderId(providerId: string): boolean {
  return LOCAL_PROVIDER_IDS.has(providerId);
}

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function formatDimension(dimension?: number): string | null {
  if (typeof dimension !== 'number') {
    return null;
  }
  return `${numberFormatter.format(dimension)} dims`;
}

function resolveSizeLabel(parameters: DbModel['parameters']): string | null {
  if (!parameters) {
    return null;
  }
  const sizeValue = (parameters as Record<string, unknown>)['size'];
  return typeof sizeValue === 'string' ? sizeValue : null;
}

function buildProviderGroups(models: DbModel[], providers: DbProvider[]): ProviderGroup[] {
  const providerMap = new Map<string, DbProvider>(
    providers.map((provider) => [provider.id, provider])
  );
  const grouped = new Map<string, ProviderGroup>();
  const unknownModels: DbModel[] = [];

  for (const model of models) {
    const provider = providerMap.get(model.providerId);
    if (!provider) {
      unknownModels.push(model);
      continue;
    }
    const existing = grouped.get(provider.id);
    if (existing) {
      existing.models.push(model);
    } else {
      grouped.set(provider.id, {
        id: provider.id,
        models: [model],
        name: provider.name,
      });
    }
  }

  const orderedGroups: ProviderGroup[] = [];
  for (const provider of providers) {
    const group = grouped.get(provider.id);
    if (group) {
      orderedGroups.push(group);
    }
  }

  if (unknownModels.length > 0) {
    orderedGroups.push({
      id: 'unknown',
      models: unknownModels,
      name: 'Unknown Provider',
    });
  }

  return orderedGroups;
}

function getProviderColorSeed(providerName: string): string {
  let hash = 0;
  for (let i = 0; i < providerName.length; i += 1) {
    hash = providerName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hex = (hash & 0x00_ff_ff_ff).toString(16).toUpperCase();
  return `#${'00000'.slice(0, 6 - hex.length)}${hex}`;
}

function ModelMetaBadges({ model, dimensionLabel, sizeLabel }: ModelMetaBadgesProps) {
  return (
    <>
      {model.capabilities.streaming ? (
        <Badge className="h-5 gap-1 px-2 text-[10px]" variant="secondary">
          <Zap className="h-3 w-3" />
          Streaming
        </Badge>
      ) : null}
      {dimensionLabel ? (
        <Badge className="h-5 px-2 text-[10px]" variant="secondary">
          {dimensionLabel}
        </Badge>
      ) : null}
      {sizeLabel ? (
        <Badge className="h-5 px-2 text-[10px]" variant="outline">
          {sizeLabel}
        </Badge>
      ) : null}
    </>
  );
}

function ModelTagline({ tagline }: { tagline: string | null }) {
  if (!tagline) {
    return null;
  }

  return <p className="text-muted-foreground text-xs">{tagline}</p>;
}

function ModelDescription({ description }: { description: string | null }) {
  if (!description) {
    return null;
  }

  return <p className="text-muted-foreground text-xs">{description}</p>;
}

function ModelBestForTags({ modelId, tags }: ModelBestForTagsProps) {
  if (tags.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Badge className="h-5 px-2 text-[10px]" key={`${modelId}-${tag}`} variant="outline">
          {tag}
        </Badge>
      ))}
    </div>
  );
}

function ModelCachePath({
  isLocal,
  modelId,
  modelCacheDir,
  downloadedModels,
}: ModelCachePathProps) {
  if (!(isLocal && downloadedModels[modelId])) {
    return null;
  }

  const cachePath = modelCacheDir ? `${modelCacheDir}/${modelId}` : 'Cached in system default';

  return <p className="font-mono text-[10px] text-muted-foreground">{cachePath}</p>;
}

function ModelDownloadProgress({
  isLocal,
  modelId,
  downloadProgress,
  isDownloading,
}: ModelDownloadProgressProps) {
  if (!(isLocal && isDownloading[modelId])) {
    return null;
  }

  const progress = downloadProgress[modelId] ?? 0;

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs">
      <Loader2 className="h-3 w-3 animate-spin" />
      {progress}% downloaded
    </div>
  );
}

function ModelDownloadControls({
  isLocal,
  modelId,
  downloadedModels,
  isDownloading,
  onDownload,
}: ModelDownloadControlsProps) {
  if (!isLocal) {
    return null;
  }

  if (isDownloading[modelId]) {
    return (
      <Badge className="h-5 px-2 text-[10px]" variant="secondary">
        Downloading
      </Badge>
    );
  }

  if (downloadedModels[modelId]) {
    return (
      <Badge
        className="bg-green-500/10 text-[10px] text-green-600 hover:bg-green-500/20"
        variant="secondary"
      >
        <Check className="mr-1 h-3 w-3" />
        Downloaded
      </Badge>
    );
  }

  return (
    <Button
      className="h-7 gap-1 px-2 text-[10px]"
      onClick={() => onDownload(modelId)}
      size="sm"
      variant="outline"
    >
      <Download className="h-3 w-3" />
      Download
    </Button>
  );
}

function ModelRow({
  model,
  modelCacheDir,
  downloadedModels,
  isDownloading,
  downloadProgress,
  onToggle,
  onDownload,
  pendingModelIds,
}: ModelRowProps) {
  const isLocal = isLocalProviderId(model.providerId);
  const bestForTags = Array.isArray(model.bestFor) ? model.bestFor : [];
  const dimensionLabel = formatDimension(model.capabilities.defaultDimension);
  const sizeLabel = resolveSizeLabel(model.parameters);
  const isPending = pendingModelIds.has(model.id);

  return (
    <div
      className={cn(
        'flex flex-col gap-2 px-4 py-3 transition-colors',
        model.isEnabled && 'bg-primary/5 outline outline-1 outline-primary/20',
        !model.isEnabled && 'hover:bg-muted/20'
      )}
      data-testid={`model-row-${model.id}`}
    >
      <div className="flex items-start gap-4">
        <div className="pt-1">
          <Switch
            aria-busy={isPending}
            aria-label={`Enable ${model.name}`}
            checked={model.isEnabled}
            data-testid={`model-toggle-${model.id}`}
            disabled={isPending}
            onCheckedChange={(checked) => onToggle(model.id, checked)}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-sm">{model.name}</span>
            <ModelMetaBadges dimensionLabel={dimensionLabel} model={model} sizeLabel={sizeLabel} />
          </div>

          <ModelTagline tagline={model.tagline} />

          <ModelDescription description={model.description} />

          <ModelBestForTags modelId={model.id} tags={bestForTags} />

          <div className="space-y-1">
            <p className="font-mono text-[10px] text-muted-foreground">{model.id}</p>
            <ModelCachePath
              downloadedModels={downloadedModels}
              isLocal={isLocal}
              modelCacheDir={modelCacheDir}
              modelId={model.id}
            />
          </div>

          <ModelDownloadProgress
            downloadProgress={downloadProgress}
            isDownloading={isDownloading}
            isLocal={isLocal}
            modelId={model.id}
          />
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <ModelDownloadControls
              downloadedModels={downloadedModels}
              isDownloading={isDownloading}
              isLocal={isLocal}
              modelId={model.id}
              onDownload={onDownload}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

interface ModelListContentProps {
  downloadedModels: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  emptyStateMessage: string;
  isDownloading: Record<string, boolean>;
  modelCacheDir?: string | null | undefined;
  onDownload: (modelId: string) => void;
  onToggle: (modelId: string, enabled: boolean) => void;
  pendingModelIds: ReadonlySet<string>;
  sections: ModelSection[];
  visibleModels: DbModel[];
}

function ModelListContent({
  visibleModels,
  sections,
  emptyStateMessage,
  downloadedModels,
  isDownloading,
  downloadProgress,
  modelCacheDir,
  onToggle,
  onDownload,
  pendingModelIds,
}: ModelListContentProps) {
  return (
    <ScrollArea className="h-[620px] rounded-lg border bg-muted/10">
      <div className="space-y-6 p-4">
        {visibleModels.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">
            {emptyStateMessage}
          </div>
        ) : (
          sections.map((section) => (
            <div className="space-y-3" key={section.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-sm">{section.title}</h3>
                  <p className="text-muted-foreground text-xs">{section.description}</p>
                </div>
                <Badge className="h-5 px-2 text-[10px]" variant="secondary">
                  {section.modelsCount} models
                </Badge>
              </div>

              <div className="space-y-4">
                {section.groups.map((group) => (
                  <Card className="overflow-hidden border-border/60 bg-card/70" key={group.id}>
                    <div className="flex items-center justify-between border-border/60 border-b px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: getProviderColorSeed(group.name) }}
                        />
                        <span className="font-medium text-sm">{group.name}</span>
                      </div>
                      <Badge className="h-5 px-2 text-[10px]" variant="outline">
                        {group.models.length}
                      </Badge>
                    </div>

                    <div className="divide-y divide-border/60">
                      {group.models.map((model) => (
                        <ModelRow
                          downloadedModels={downloadedModels}
                          downloadProgress={downloadProgress}
                          isDownloading={isDownloading}
                          key={model.id}
                          model={model}
                          modelCacheDir={modelCacheDir ?? null}
                          onDownload={onDownload}
                          onToggle={onToggle}
                          pendingModelIds={pendingModelIds}
                        />
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  );
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
  pendingModelIds = new Set<string>(),
}: ModelListProps) {
  const [search, setSearch] = useState<string>('');
  const [activeTab, setActiveTab] = useState<ModelCategory>('chat');
  const [showLocal, setShowLocal] = useState<boolean>(true);
  const [showRemote, setShowRemote] = useState<boolean>(true);

  const providerLookup = useMemo(
    () => new Map<string, DbProvider>(providers.map((provider) => [provider.id, provider])),
    [providers]
  );

  const normalizedSearch = normalizeSearchQuery(search);

  const modelsByType = useMemo(() => {
    const targetType = activeTab === 'chat' ? 'llm' : 'embedding';
    return models.filter((model) => model.capabilities.type === targetType);
  }, [models, activeTab]);

  const filteredModels = useMemo(() => {
    if (!normalizedSearch) {
      return modelsByType;
    }

    return modelsByType.filter((model) => {
      const providerName = providerLookup.get(model.providerId)?.name ?? model.providerId;
      const searchTargets: string[] = [
        model.name,
        model.id,
        model.providerId,
        providerName,
        model.description ?? '',
        model.tagline ?? '',
      ];
      if (Array.isArray(model.bestFor)) {
        searchTargets.push(...model.bestFor);
      }

      return searchTargets.some((target) => target.toLowerCase().includes(normalizedSearch));
    });
  }, [modelsByType, normalizedSearch, providerLookup]);

  const localModels = useMemo(
    () => filteredModels.filter((model) => isLocalProviderId(model.providerId)),
    [filteredModels]
  );

  const remoteModels = useMemo(
    () => filteredModels.filter((model) => !isLocalProviderId(model.providerId)),
    [filteredModels]
  );

  const localAvailable = useMemo(
    () => modelsByType.some((model) => isLocalProviderId(model.providerId)),
    [modelsByType]
  );

  const remoteAvailable = useMemo(
    () => modelsByType.some((model) => !isLocalProviderId(model.providerId)),
    [modelsByType]
  );

  const activeLocal = showLocal && localAvailable;
  const activeRemote = showRemote && remoteAvailable;

  const visibleModels = useMemo(() => {
    const visible: DbModel[] = [];
    if (activeRemote) {
      visible.push(...remoteModels);
    }
    if (activeLocal) {
      visible.push(...localModels);
    }
    return visible;
  }, [activeLocal, activeRemote, localModels, remoteModels]);

  const enabledVisibleCount = visibleModels.filter((model) => model.isEnabled).length;

  const sections = useMemo<ModelSection[]>(() => {
    const sectionList: ModelSection[] = [];
    if (activeRemote) {
      sectionList.push({
        description: 'Hosted providers (OpenAI, Anthropic, Google, and more).',
        groups: buildProviderGroups(remoteModels, providers),
        id: 'remote',
        modelsCount: remoteModels.length,
        title: 'Remote Models',
      });
    }
    if (activeLocal) {
      sectionList.push({
        description: 'On-device transformer models cached to disk.',
        groups: buildProviderGroups(localModels, providers),
        id: 'local',
        modelsCount: localModels.length,
        title: 'Local Models',
      });
    }
    return sectionList;
  }, [activeLocal, activeRemote, localModels, providers, remoteModels]);

  const handleTabChange = (value: string): void => {
    if (value === 'chat' || value === 'embedding') {
      setActiveTab(value);
    }
  };

  const emptyStateMessage =
    activeLocal || activeRemote
      ? normalizedSearch
        ? 'No models match this search yet.'
        : 'No models available for this category yet.'
      : 'Enable Local or Remote to view models.';

  return (
    <div className="flex h-full flex-col gap-4">
      <Tabs onValueChange={handleTabChange} value={activeTab}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <TabsList className="h-9">
              <TabsTrigger className="px-4 text-sm" value="chat">
                Chat
              </TabsTrigger>
              <TabsTrigger className="px-4 text-sm" value="embedding">
                Embeddings
              </TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-1 text-muted-foreground text-xs">
              <span className="font-semibold text-foreground">{enabledVisibleCount}</span>
              enabled of {visibleModels.length}
            </div>
          </div>

          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center lg:w-auto">
            <div className="relative flex-1 sm:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search models, providers, or tags"
                value={search}
              />
            </div>
            <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
              <Button
                aria-pressed={showRemote}
                className={cn(
                  'h-8 gap-2 px-3 text-[11px]',
                  showRemote && 'bg-accent text-accent-foreground'
                )}
                disabled={!remoteAvailable}
                onClick={() => setShowRemote((prev) => !prev)}
                size="sm"
                variant="ghost"
              >
                Remote
                <Badge className="h-4 px-1 text-[10px]" variant="secondary">
                  {remoteModels.length}
                </Badge>
              </Button>
              <Button
                aria-pressed={showLocal}
                className={cn(
                  'h-8 gap-2 px-3 text-[11px]',
                  showLocal && 'bg-accent text-accent-foreground'
                )}
                disabled={!localAvailable}
                onClick={() => setShowLocal((prev) => !prev)}
                size="sm"
                variant="ghost"
              >
                Local
                <Badge className="h-4 px-1 text-[10px]" variant="secondary">
                  {localModels.length}
                </Badge>
              </Button>
            </div>
          </div>
        </div>

        <TabsContent className="mt-4" value="chat">
          <ModelListContent
            downloadedModels={downloadedModels}
            downloadProgress={downloadProgress}
            emptyStateMessage={emptyStateMessage}
            isDownloading={isDownloading}
            modelCacheDir={modelCacheDir}
            onDownload={onDownload}
            onToggle={onToggle}
            pendingModelIds={pendingModelIds}
            sections={sections}
            visibleModels={visibleModels}
          />
        </TabsContent>
        <TabsContent className="mt-4" value="embedding">
          <ModelListContent
            downloadedModels={downloadedModels}
            downloadProgress={downloadProgress}
            emptyStateMessage={emptyStateMessage}
            isDownloading={isDownloading}
            modelCacheDir={modelCacheDir}
            onDownload={onDownload}
            onToggle={onToggle}
            pendingModelIds={pendingModelIds}
            sections={sections}
            visibleModels={visibleModels}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
