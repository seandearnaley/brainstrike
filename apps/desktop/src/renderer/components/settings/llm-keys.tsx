import {
  listProviders,
  type ProviderDefinition,
  type ProviderModelDefinition,
  type SupportedProvider,
} from '@brainstrike/agent/client';
import { useAssistantPreferencesStore } from '@brainstrike/preferences';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@brainstrike/ui';
import { SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

export function LlmKeysSettings() {
  const { toast } = useToast();
  const providerDefinitions = useMemo(() => listProviders(), []);
  const providerOptions = useMemo(
    () =>
      providerDefinitions.map((definition) => ({
        id: definition.id,
        name: definition.displayName,
      })),
    [providerDefinitions]
  );

  const [provider, setProvider] = useState<string>(providerOptions[0]?.id ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [providersWithSecrets, setProvidersWithSecrets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!providerOptions.some((option) => option.id === provider) && providerOptions[0]) {
      setProvider(providerOptions[0].id);
    }
  }, [providerOptions, provider]);

  const selectedProviderName = useMemo(
    () => providerOptions.find((option) => option.id === provider)?.name ?? provider,
    [providerOptions, provider]
  );

  const refreshProviders = useCallback(async () => {
    try {
      const list = await window.secrets?.list?.();
      if (Array.isArray(list)) {
        setProvidersWithSecrets(list);
      }
    } catch {
      // ignored
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      const res = await window.secrets?.saveKey?.(provider, apiKey.trim());
      if (res && typeof res === 'object' && 'ok' in res) {
        const result = res as { ok: false; error: 'encryption_unavailable' | 'unknown_error' };
        if (result.ok === false) {
          const code = result.error;
          toast({
            title: 'Failed to save key',
            description:
              code === 'encryption_unavailable'
                ? 'OS keychain encryption is unavailable on this system.'
                : 'Unknown error occurred while saving the key.',
            variant: 'destructive',
          });
        }
      }
      setApiKey('');
      await refreshProviders();
    } finally {
      setBusy(false);
    }
  }, [apiKey, provider, refreshProviders, toast]);

  const handleDelete = useCallback(async () => {
    setBusy(true);
    try {
      await window.secrets?.deleteKey?.(provider);
      await refreshProviders();
    } finally {
      setBusy(false);
    }
  }, [provider, refreshProviders]);

  const providerId = useId();
  const apiKeyId = useId();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provider API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 items-end sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={providerId}>Provider</Label>
              <Select value={provider} onValueChange={(value) => setProvider(value)}>
                <SelectTrigger id={providerId} data-testid="llm-provider">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={apiKeyId}>API Key</Label>
              <Input
                id={apiKeyId}
                data-testid="llm-api-key"
                type="password"
                placeholder={`Enter ${selectedProviderName} API key`}
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              data-testid="save-llm-key"
              disabled={busy || !apiKey.trim()}
              onClick={handleSave}
            >
              Save
            </Button>
            <Button
              data-testid="delete-llm-key"
              variant="secondary"
              disabled={busy}
              onClick={handleDelete}
            >
              Delete
            </Button>
          </div>

          <div className="space-y-1">
            <Label>Saved Providers</Label>
            <div data-testid="saved-llm-providers" className="text-xs text-muted-foreground">
              {providersWithSecrets.length === 0 ? 'None' : providersWithSecrets.join(', ')}
            </div>
          </div>
        </CardContent>
      </Card>

      <ModelAvailabilityCard providerDefinitions={providerDefinitions} />
      <ProviderCapabilitiesCard
        providerDefinitions={providerDefinitions}
        providersWithSecrets={providersWithSecrets}
      />
    </div>
  );
}

export default LlmKeysSettings;

interface ModelAvailabilityCardProps {
  providerDefinitions: readonly ProviderDefinition[];
}

function ModelAvailabilityCard({ providerDefinitions }: ModelAvailabilityCardProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const setModelEnabled = useAssistantPreferencesStore((state) => state.setModelEnabled);
  const setProviderModelsEnabled = useAssistantPreferencesStore(
    (state) => state.setProviderModelsEnabled
  );

  const normalizedSearch = searchTerm.trim().toLowerCase();

  const handleEnableAllProviders = useCallback(() => {
    for (const definition of providerDefinitions) {
      const providerId = definition.id as SupportedProvider;
      const llmModels = definition.models.filter(
        (model): model is ProviderModelDefinition & { type: 'llm' } => model.type === 'llm'
      );
      if (llmModels.length === 0) continue;
      setProviderModelsEnabled(
        providerId,
        llmModels.map((model) => model.id),
        true
      );
    }
  }, [providerDefinitions, setProviderModelsEnabled]);

  const handleDisableAllProviders = useCallback(() => {
    for (const definition of providerDefinitions) {
      const providerId = definition.id as SupportedProvider;
      const llmModels = definition.models.filter(
        (model): model is ProviderModelDefinition & { type: 'llm' } => model.type === 'llm'
      );
      if (llmModels.length === 0) continue;
      setProviderModelsEnabled(
        providerId,
        llmModels.map((model) => model.id),
        false
      );
    }
  }, [providerDefinitions, setProviderModelsEnabled]);

  const sections = providerDefinitions
    .map((definition) => {
      const providerId = definition.id as SupportedProvider;
      const llmModels = definition.models.filter(
        (model): model is ProviderModelDefinition & { type: 'llm' } => model.type === 'llm'
      );
      if (llmModels.length === 0) {
        return null;
      }

      const visibleModels = normalizedSearch
        ? llmModels.filter((model) => {
            const label = model.label ?? model.id;
            return (
              label.toLowerCase().includes(normalizedSearch) ||
              model.id.toLowerCase().includes(normalizedSearch)
            );
          })
        : llmModels;

      if (visibleModels.length === 0) {
        return null;
      }

      const modelIds = llmModels.map((model) => model.id);

      return (
        <ProviderModelSection
          key={definition.id}
          definition={definition}
          providerId={providerId}
          allModels={llmModels}
          visibleModels={visibleModels}
          onToggleModel={(modelId, enabled) => setModelEnabled(providerId, modelId, enabled)}
          onEnableAll={() => setProviderModelsEnabled(providerId, modelIds, true)}
          onDisableAll={() => setProviderModelsEnabled(providerId, modelIds, false)}
        />
      );
    })
    .filter(Boolean);

  const hasRenderableProvider = sections.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Model Availability</CardTitle>
        <p className="text-sm text-muted-foreground">
          Enable or disable individual LLM models per provider. Changes here control which options
          appear in the assistant model picker. Embedding models are configured separately in
          Embedding Settings.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-xs">
            <Input
              aria-label="Search models"
              placeholder="Search models"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.currentTarget.value)}
              className="pl-9"
            />
            <SearchIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleEnableAllProviders}
              data-testid="enable-all-models"
            >
              Enable all models
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDisableAllProviders}
              data-testid="disable-all-models"
            >
              Disable all models
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {hasRenderableProvider ? (
            sections
          ) : (
            <p className="text-xs text-muted-foreground">No providers match the current search.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface ProviderModelSectionProps {
  definition: ProviderDefinition;
  providerId: SupportedProvider;
  allModels: readonly (ProviderModelDefinition & { type: 'llm' })[];
  visibleModels: readonly (ProviderModelDefinition & { type: 'llm' })[];
  onToggleModel: (modelId: string, enabled: boolean) => void;
  onEnableAll: () => void;
  onDisableAll: () => void;
}

function ProviderModelSection({
  definition,
  providerId,
  allModels,
  visibleModels,
  onToggleModel,
  onEnableAll,
  onDisableAll,
}: ProviderModelSectionProps) {
  const enabledModels = useEnabledModels(providerId);
  const enabledSet = useMemo(() => new Set(enabledModels), [enabledModels]);

  const totalModels = allModels.length;
  const enabledCount = allModels.reduce(
    (count, model) => count + (enabledSet.has(model.id) ? 1 : 0),
    0
  );
  const allEnabled = enabledCount === totalModels && totalModels > 0;
  const noneEnabled = enabledCount === 0;

  return (
    <section
      className="rounded-lg border border-border/60 bg-muted/10"
      data-testid={`provider-model-section-${definition.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div>
          <p className="text-sm font-medium leading-tight">{definition.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {enabledCount} of {totalModels} models enabled
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onEnableAll}
            disabled={allEnabled}
            data-testid={`enable-all-${providerId}`}
          >
            Enable all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDisableAll}
            disabled={noneEnabled}
            data-testid={`disable-all-${providerId}`}
          >
            Disable all
          </Button>
        </div>
      </div>
      <div className="space-y-2 px-3 py-3">
        {visibleModels.length === 0 ? (
          <p className="text-xs text-muted-foreground">No models match the current search.</p>
        ) : (
          visibleModels.map((model) => (
            <ModelToggleRow
              key={model.id}
              providerId={providerId}
              model={model}
              enabled={enabledSet.has(model.id)}
              onToggle={(next) => onToggleModel(model.id, next)}
            />
          ))
        )}
      </div>
    </section>
  );
}

interface ModelToggleRowProps {
  providerId: SupportedProvider;
  model: ProviderModelDefinition & { type: 'llm' };
  enabled: boolean;
  onToggle: (next: boolean) => void;
}

function ModelToggleRow({ providerId, model, enabled, onToggle }: ModelToggleRowProps) {
  const handleCheckedChange = (checked: boolean | 'indeterminate') => {
    onToggle(checked === true);
  };

  const label = model.label ?? model.id;

  return (
    <div
      className={`flex h-full items-center justify-between gap-3 rounded-md px-3 py-2 ${
        enabled ? 'bg-background' : 'bg-muted/50'
      }`}
      data-testid={`model-row-${providerId}-${model.id}`}
    >
      <div className="flex items-center gap-3">
        <Checkbox
          aria-label={`Enable ${label}`}
          checked={enabled}
          onCheckedChange={handleCheckedChange}
          data-testid={`model-toggle-${providerId}-${model.id}`}
        />
        <div className="text-left leading-tight">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{model.id}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1 text-[11px] text-muted-foreground">
        {model.default && <Badge variant="outline">Default</Badge>}
        {model.supportsStreaming && <Badge variant="outline">Streaming</Badge>}
      </div>
    </div>
  );
}

function useEnabledModels(providerId: SupportedProvider) {
  return useAssistantPreferencesStore((state) => state.enabledModelsByProvider[providerId] ?? []);
}

interface ProviderCapabilitiesCardProps {
  providerDefinitions: readonly ProviderDefinition[];
  providersWithSecrets: string[];
}

function ProviderCapabilitiesCard({
  providerDefinitions,
  providersWithSecrets,
}: ProviderCapabilitiesCardProps) {
  const secretsSet = new Set(providersWithSecrets);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Provider Capabilities</CardTitle>
        <p className="text-sm text-muted-foreground">
          Overview of what each provider supports. Providers with embeddings capability can be used
          for vector search and semantic indexing.
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {providerDefinitions.map((provider) => {
            const hasApiKey = secretsSet.has(provider.id);
            const capabilities = [];
            if (provider.capabilities.llm) capabilities.push('LLM');
            if (provider.capabilities.embeddings) capabilities.push('Embeddings');
            if (provider.capabilities.streaming) capabilities.push('Streaming');

            return (
              <div
                key={provider.id}
                className="flex items-center justify-between rounded-md border border-border/60 bg-muted/10 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{provider.displayName}</p>
                  {hasApiKey && <Badge variant="secondary">API Key Saved</Badge>}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {capabilities.map((cap) => (
                    <Badge key={cap} variant="outline" className="text-[11px]">
                      {cap}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
